import * as cdk from 'aws-cdk-lib';
import * as appstream from 'aws-cdk-lib/aws-appstream';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { UatConfig, ssmPrefix } from './config';

export interface UatDesktopStackProps extends cdk.StackProps {
  config: UatConfig;
  vpc: ec2.IVpc;
  s3Endpoint: ec2.IGatewayVpcEndpoint;
}

export class UatDesktopStack extends cdk.Stack {
  public readonly key: kms.Key;
  public readonly evidenceBucket: s3.Bucket;
  public readonly buildsBucket: s3.Bucket;
  public readonly fleetName: string;
  public readonly stackName_: string;
  public readonly leaseParameterName: string;

  constructor(scope: Construct, id: string, props: UatDesktopStackProps) {
    super(scope, id, props);
    const c = props.config;
    const prefix = ssmPrefix(c);
    this.fleetName = c.fleet.name;
    this.stackName_ = c.stack.name;
    this.leaseParameterName = `${prefix}/fleet-lease`;

    // ---------------------------------------------------------------- KMS
    this.key = new kms.Key(this, 'Key', {
      alias: `alias/desktop-uat-${c.envName}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      description: 'Desktop UAT evidence and build artifacts',
    });

    // ---------------------------------------------------------------- Buckets
    const accessLogs = new s3.Bucket(this, 'AccessLogs', {
      encryption: s3.BucketEncryption.S3_MANAGED, // server access logging cannot target SSE-KMS buckets
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      lifecycleRules: [{ expiration: cdk.Duration.days(365) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Screenshots uploaded by the agent-access service (using the agent's credentials)
    // and evidence/report files uploaded by the harness.
    this.evidenceBucket = new s3.Bucket(this, 'Evidence', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: false,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'evidence/',
      lifecycleRules: [{ expiration: cdk.Duration.days(c.evidenceRetentionDays) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    // Required by agent access: the AppStream service principal must be able to list the bucket.
    this.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AppStreamAgentAccessList',
      principals: [new iam.ServicePrincipal('appstream.amazonaws.com')],
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      resources: [this.evidenceBucket.bucketArn],
      conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
    }));

    // Staging copy of the Artifactory release under test (Artifactory stays the source of truth).
    // Readable only through the VPC's S3 gateway endpoint, i.e. by the isolated fleet
    // using a short-lived presigned URL minted by the runner.
    this.buildsBucket = new s3.Bucket(this, 'Builds', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogs,
      serverAccessLogsPrefix: 'builds/',
      lifecycleRules: [{ expiration: cdk.Duration.days(c.buildRetentionDays) }],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.buildsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyGetOutsideVpc',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:GetObject'],
      resources: [this.buildsBucket.arnForObjects('*')],
      conditions: { StringNotEquals: { 'aws:SourceVpce': props.s3Endpoint.vpcEndpointId } },
    }));

    // ---------------------------------------------------------------- Fleet
    const fleetSg = new ec2.SecurityGroup(this, 'FleetSg', {
      vpc: props.vpc,
      allowAllOutbound: false,
      description: 'UAT streaming desktops - isolated subnets, S3 gateway endpoint only',
    });
    // Isolated subnets have no default route, so 443 egress can only reach the S3 gateway endpoint.
    fleetSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS to S3 via gateway endpoint');

    const fleet = new appstream.CfnFleet(this, 'Fleet', {
      name: c.fleet.name,
      displayName: `Desktop UAT (${c.envName})`,
      description: 'Agentic UAT/beta testing desktops',
      fleetType: 'ON_DEMAND', // agent access does not support Elastic or multi-session fleets
      instanceType: c.fleet.instanceType,
      imageName: c.fleet.imageName,
      computeCapacity: { desiredInstances: c.fleet.maxConcurrentSessions },
      streamView: 'DESKTOP',
      enableDefaultInternetAccess: false,
      vpcConfig: {
        subnetIds: props.vpc.selectSubnets({ subnetGroupName: 'fleet' }).subnetIds,
        securityGroupIds: [fleetSg.securityGroupId],
      },
      maxUserDurationInSeconds: c.fleet.maxSessionSeconds,
      disconnectTimeoutInSeconds: 60,
      idleDisconnectTimeoutInSeconds: 900,
    });

    // ---------------------------------------------------------------- Agent-enabled stack
    const stack = new appstream.CfnStack(this, 'AgentStack', {
      name: c.stack.name,
      displayName: `Desktop UAT agents (${c.envName})`,
      description: 'Agent access stack for agentic UAT. Not for human users.',
    });
    // Set via override so this works whether or not the installed aws-cdk-lib
    // version has the typed L1 property yet. Shape per AWS::AppStream::Stack AgentAccessConfig.
    stack.addPropertyOverride('AgentAccessConfig', {
      ScreenResolution: 'W_1280xH_720',
      ScreenImageFormat: c.stack.screenImageFormat,
      UserControlMode: c.stack.userControlMode,
      ScreenshotsUploadEnabled: true,
      S3BucketArn: this.evidenceBucket.bucketArn,
      Settings: [
        { AgentAction: 'COMPUTER_VISION', Permission: 'ENABLED' },
        { AgentAction: 'COMPUTER_INPUT', Permission: 'ENABLED' },
        { AgentAction: 'FORWARD_MCP_TOOLS', Permission: 'ENABLED' },
      ],
    });

    const assoc = new appstream.CfnStackFleetAssociation(this, 'Association', {
      fleetName: c.fleet.name,
      stackName: c.stack.name,
    });
    // Names are plain strings, so CloudFormation cannot infer ordering on its own.
    assoc.addDependency(fleet);
    assoc.addDependency(stack);

    // ---------------------------------------------------------------- Optional image builder
    if (c.createImageBuilder) {
      const ibSg = new ec2.SecurityGroup(this, 'ImageBuilderSg', {
        vpc: props.vpc,
        allowAllOutbound: true,
        description: 'Image builder - needs egress to install dependencies',
      });
      new appstream.CfnImageBuilder(this, 'ImageBuilder', {
        name: `desktop-uat-ib-${c.envName}`,
        instanceType: 'stream.standard.large',
        imageName: c.imageBuilderBaseImage,
        enableDefaultInternetAccess: false,
        vpcConfig: {
          subnetIds: [props.vpc.selectSubnets({ subnetGroupName: 'runners' }).subnetIds[0]],
          securityGroupIds: [ibSg.securityGroupId],
        },
      });
    }

    // ---------------------------------------------------------------- Lease parameter
    // The workflow writes an expiry epoch here while it needs the fleet;
    // the janitor will not stop a fleet whose lease is still valid.
    new ssm.StringParameter(this, 'LeaseParam', {
      parameterName: this.leaseParameterName,
      stringValue: '0',
      description: 'Epoch seconds until which a workflow holds the UAT fleet',
    });

    // ---------------------------------------------------------------- Fleet janitor
    const janitorLogs = new logs.LogGroup(this, 'JanitorLogs', {
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const janitor = new lambda.Function(this, 'FleetJanitor', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(60),
      logGroup: janitorLogs,
      description: 'Stops the UAT fleet when idle and unleased (cost safety net)',
      environment: {
        FLEET_NAME: c.fleet.name,
        STACK_NAME: c.stack.name,
        LEASE_PARAM: this.leaseParameterName,
      },
      code: lambda.Code.fromInline(`
const { AppStreamClient, DescribeFleetsCommand, DescribeSessionsCommand, StopFleetCommand } = require('@aws-sdk/client-appstream');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const as = new AppStreamClient({});
const ssm = new SSMClient({});
exports.handler = async () => {
  const { FLEET_NAME, STACK_NAME, LEASE_PARAM } = process.env;
  const fleet = (await as.send(new DescribeFleetsCommand({ Names: [FLEET_NAME] }))).Fleets?.[0];
  if (!fleet || fleet.State !== 'RUNNING') return { action: 'none', state: fleet?.State };
  const lease = Number((await ssm.send(new GetParameterCommand({ Name: LEASE_PARAM }))).Parameter?.Value ?? '0');
  const now = Math.floor(Date.now() / 1000);
  if (lease > now) return { action: 'none', reason: 'lease held', leaseExpiresIn: lease - now };
  const sessions = await as.send(new DescribeSessionsCommand({ StackName: STACK_NAME, FleetName: FLEET_NAME }));
  if ((sessions.Sessions ?? []).length > 0) return { action: 'none', reason: 'active sessions' };
  await as.send(new StopFleetCommand({ Name: FLEET_NAME }));
  console.log(JSON.stringify({ action: 'stopped', fleet: FLEET_NAME }));
  return { action: 'stopped' };
};`),
    });
    janitor.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appstream:DescribeFleets', 'appstream:DescribeSessions'],
      resources: ['*'],
    }));
    janitor.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appstream:StopFleet'],
      resources: [this.fleetArn(c.fleet.name)],
    }));
    janitor.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.paramArn(this.leaseParameterName)],
    }));
    new events.Rule(this, 'JanitorSchedule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(Math.max(15, Math.floor(c.janitorIdleMinutes / 3)))),
      targets: [new targets.LambdaFunction(janitor)],
    });

    // ---------------------------------------------------------------- Discovery parameters
    // The workflow and harness read everything from SSM; nothing is hard-coded in YAML.
    const params: Record<string, string> = {
      'region': this.region,
      'fleet-name': c.fleet.name,
      'stack-name': c.stack.name,
      'evidence-bucket': this.evidenceBucket.bucketName,
      'builds-bucket': this.buildsBucket.bucketName,
      'mcp-endpoint': `https://agentaccess-mcp.${this.region}.api.aws/mcp`,
      'bedrock-model-id': c.bedrockModelId,
      'max-concurrent-sessions': String(c.fleet.maxConcurrentSessions),
    };
    for (const [k, v] of Object.entries(params)) {
      new ssm.StringParameter(this, `P-${k}`, { parameterName: `${prefix}/${k}`, stringValue: v });
    }

    new cdk.CfnOutput(this, 'FleetName', { value: c.fleet.name });
    new cdk.CfnOutput(this, 'StackName', { value: c.stack.name });
    new cdk.CfnOutput(this, 'EvidenceBucket', { value: this.evidenceBucket.bucketName });
    new cdk.CfnOutput(this, 'BuildsBucket', { value: this.buildsBucket.bucketName });
  }

  fleetArn(name: string): string {
    return `arn:${this.partition}:appstream:${this.region}:${this.account}:fleet/${name}`;
  }

  stackArn(name: string): string {
    return `arn:${this.partition}:appstream:${this.region}:${this.account}:stack/${name}`;
  }

  paramArn(name: string): string {
    return `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${name}`;
  }
}
