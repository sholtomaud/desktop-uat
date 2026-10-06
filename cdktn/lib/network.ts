import { CloudwatchLogGroup } from '@cdktn/provider-aws/lib/cloudwatch-log-group';
import { DataAwsIamPolicyDocument } from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { DefaultSecurityGroup } from '@cdktn/provider-aws/lib/default-security-group';
import { Eip } from '@cdktn/provider-aws/lib/eip';
import { FlowLog } from '@cdktn/provider-aws/lib/flow-log';
import { IamRole } from '@cdktn/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktn/provider-aws/lib/iam-role-policy';
import { InternetGateway } from '@cdktn/provider-aws/lib/internet-gateway';
import { NatGateway } from '@cdktn/provider-aws/lib/nat-gateway';
import { Route } from '@cdktn/provider-aws/lib/route';
import { RouteTable } from '@cdktn/provider-aws/lib/route-table';
import { RouteTableAssociation } from '@cdktn/provider-aws/lib/route-table-association';
import { SecurityGroup } from '@cdktn/provider-aws/lib/security-group';
import { Subnet } from '@cdktn/provider-aws/lib/subnet';
import { Vpc } from '@cdktn/provider-aws/lib/vpc';
import { VpcEndpoint } from '@cdktn/provider-aws/lib/vpc-endpoint';
import { VpcSecurityGroupIngressRule } from '@cdktn/provider-aws/lib/vpc-security-group-ingress-rule';
import { Construct } from 'constructs';
import { UatConfig, allocateSubnets, availabilityZones } from './config';

export type Tier = 'public' | 'runners' | 'fleet';

export interface NetworkProps {
  config: UatConfig;
}

/**
 * Three subnet tiers, as in infra/lib/network-stack.ts:
 *  - public:  NAT gateways only. Nothing else is placed here.
 *  - runners: egress through NAT. The GHES runners need outbound HTTPS to the
 *             agent-access MCP endpoint (agentaccess-mcp.<region>.api.aws), which
 *             has no VPC endpoint, plus GHES itself.
 *  - fleet:   isolated. The streaming desktops get no route out at all; only the
 *             S3 gateway endpoint (for pulling the build under test). Streaming
 *             and agent traffic use the service-managed interface, not this subnet.
 */
export class Network extends Construct {
  public readonly vpc: Vpc;
  public readonly subnets: Record<Tier, Subnet[]>;
  public readonly s3Endpoint: VpcEndpoint;

  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);
    const c = props.config;
    const azs = availabilityZones(c);
    const name = (suffix: string) => `desktop-uat-${c.envName}-${suffix}`;

    this.vpc = new Vpc(this, 'vpc', {
      cidrBlock: c.vpcCidr,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: name('vpc') },
    });
    const vpcId = this.vpc.id;

    // Adopting the default group strips its rules, so nothing can fall back on it.
    new DefaultSecurityGroup(this, 'default_sg', { vpcId });

    const igw = new InternetGateway(this, 'igw', { vpcId, tags: { Name: name('igw') } });

    const cidrs = allocateSubnets(c.vpcCidr, [
      { name: 'public', mask: 26 },
      { name: 'runners', mask: 24 },
      { name: 'fleet', mask: 22 },
    ], azs.length);

    const tables: RouteTable[] = [];
    const tier = (t: Tier) => azs.map((az, i) => {
      const id = `${t}_${i}`;
      const tags = { Name: name(`${t}-${az}`), Tier: t };
      const subnet = new Subnet(this, id, { vpcId, availabilityZone: az, cidrBlock: cidrs[t][i], tags });
      const table = new RouteTable(this, `${id}_rt`, { vpcId, tags });
      new RouteTableAssociation(this, `${id}_assoc`, { subnetId: subnet.id, routeTableId: table.id });
      tables.push(table);
      return { subnet, table };
    });

    const pub = tier('public');
    for (const [i, { table }] of pub.entries()) {
      new Route(this, `public_${i}_default`, {
        routeTableId: table.id, destinationCidrBlock: '0.0.0.0/0', gatewayId: igw.id,
      });
    }

    const nats = Array.from({ length: Math.min(c.natGateways, azs.length) }, (_, i) => {
      const eip = new Eip(this, `nat_${i}_eip`, { domain: 'vpc', tags: { Name: name(`nat-${azs[i]}`) } });
      return new NatGateway(this, `nat_${i}`, {
        allocationId: eip.allocationId, subnetId: pub[i].subnet.id, tags: { Name: name(`nat-${azs[i]}`) },
        dependsOn: [igw],
      });
    });

    const runners = tier('runners');
    if (nats.length > 0) {
      for (const [i, { table }] of runners.entries()) {
        new Route(this, `runners_${i}_default`, {
          routeTableId: table.id, destinationCidrBlock: '0.0.0.0/0', natGatewayId: nats[i % nats.length].id,
        });
      }
    }

    // No routes: the fleet tier's only way out is the S3 gateway endpoint below.
    const fleet = tier('fleet');

    this.subnets = {
      public: pub.map(s => s.subnet),
      runners: runners.map(s => s.subnet),
      fleet: fleet.map(s => s.subnet),
    };

    // The gateway endpoint is on every route table, including the isolated fleet tier's.
    this.s3Endpoint = new VpcEndpoint(this, 's3', {
      vpcId,
      serviceName: `com.amazonaws.${c.region}.s3`,
      vpcEndpointType: 'Gateway',
      routeTableIds: tables.map(t => t.id),
      tags: { Name: name('s3') },
    });

    const endpointSg = new SecurityGroup(this, 'endpoint_sg', {
      vpcId,
      name: name('endpoints'),
      description: 'Interface endpoints - HTTPS from inside the VPC only',
    });
    new VpcSecurityGroupIngressRule(this, 'endpoint_https', {
      securityGroupId: endpointSg.id,
      description: 'HTTPS from VPC',
      cidrIpv4: c.vpcCidr,
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
    });

    // Interface endpoints live in the runner tier; the fleet tier deliberately gets none.
    for (const svc of c.interfaceEndpoints) {
      new VpcEndpoint(this, `ep_${svc.replace(/[^a-z0-9]/g, '_')}`, {
        vpcId,
        serviceName: `com.amazonaws.${c.region}.${svc}`,
        vpcEndpointType: 'Interface',
        subnetIds: this.subnets.runners.map(s => s.id),
        securityGroupIds: [endpointSg.id],
        privateDnsEnabled: true,
        tags: { Name: name(svc) },
      });
    }

    this.flowLogs(vpcId, name);
  }

  private flowLogs(vpcId: string, name: (s: string) => string) {
    const group = new CloudwatchLogGroup(this, 'flow_logs', {
      name: `/desktop-uat/${name('vpc-flow-logs')}`,
      retentionInDays: 365,
      lifecycle: { preventDestroy: true },
    });
    const assume = new DataAwsIamPolicyDocument(this, 'flow_logs_assume', {
      statement: [{
        actions: ['sts:AssumeRole'],
        principals: [{ type: 'Service', identifiers: ['vpc-flow-logs.amazonaws.com'] }],
      }],
    });
    const role = new IamRole(this, 'flow_logs_role', { namePrefix: 'desktop-uat-flow-logs-', assumeRolePolicy: assume.json });
    const write = new DataAwsIamPolicyDocument(this, 'flow_logs_write', {
      statement: [{
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams'],
        resources: [group.arn, `${group.arn}:*`],
      }],
    });
    new IamRolePolicy(this, 'flow_logs_policy', { role: role.name, policy: write.json });
    new FlowLog(this, 'flow_log', {
      vpcId,
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logDestination: group.arn,
      iamRoleArn: role.arn,
      tags: { Name: name('vpc') },
    });
  }
}
