import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { UatConfig } from './config';

export interface NetworkStackProps extends cdk.StackProps {
  config: UatConfig;
}

/**
 * Three subnet tiers:
 *  - public:  NAT gateways only. Nothing else is placed here.
 *  - runners: PRIVATE_WITH_EGRESS. The GHES runners need outbound HTTPS to the
 *             agent-access MCP endpoint (agentaccess-mcp.<region>.api.aws), which
 *             has no VPC endpoint, plus GHES itself.
 *  - fleet:   PRIVATE_ISOLATED. The streaming desktops get no internet route at
 *             all; only the S3 gateway endpoint (for pulling the build under test).
 *             Streaming and agent traffic use the service-managed interface, not
 *             this subnet.
 */
export class NetworkStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly s3Endpoint: ec2.GatewayVpcEndpoint;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const c = props.config;

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(c.vpcCidr),
      maxAzs: c.maxAzs,
      natGateways: c.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 26 },
        { name: 'runners', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'fleet', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 22 },
      ],
      flowLogs: {
        all: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    });

    // Gateway endpoint is attached to every subnet route table, including the isolated fleet tier.
    this.s3Endpoint = this.vpc.addGatewayEndpoint('S3', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: 'Interface endpoints - HTTPS from inside the VPC only',
    });
    endpointSg.addIngressRule(ec2.Peer.ipv4(c.vpcCidr), ec2.Port.tcp(443), 'HTTPS from VPC');

    // Interface endpoints live in the runner tier; the fleet tier deliberately gets none.
    for (const svc of c.interfaceEndpoints) {
      const id = svc.replace(/[^a-zA-Z0-9]/g, '');
      this.vpc.addInterfaceEndpoint(`Ep${id}`, {
        service: new ec2.InterfaceVpcEndpointAwsService(svc),
        subnets: { subnetGroupName: 'runners' },
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }

    new cdk.CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }
}
