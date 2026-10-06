import { DataArchiveFile } from '@cdktn/provider-archive/lib/data-archive-file';
import { AppstreamFleet } from '@cdktn/provider-aws/lib/appstream-fleet';
import { AppstreamFleetStackAssociation } from '@cdktn/provider-aws/lib/appstream-fleet-stack-association';
import { AppstreamImageBuilder } from '@cdktn/provider-aws/lib/appstream-image-builder';
import { CloudwatchEventRule } from '@cdktn/provider-aws/lib/cloudwatch-event-rule';
import { CloudwatchEventTarget } from '@cdktn/provider-aws/lib/cloudwatch-event-target';
import { CloudwatchLogGroup } from '@cdktn/provider-aws/lib/cloudwatch-log-group';
import {
  DataAwsIamPolicyDocument, DataAwsIamPolicyDocumentStatement,
} from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { IamRole } from '@cdktn/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktn/provider-aws/lib/iam-role-policy';
import { KmsAlias } from '@cdktn/provider-aws/lib/kms-alias';
import { KmsKey } from '@cdktn/provider-aws/lib/kms-key';
import { LambdaFunction } from '@cdktn/provider-aws/lib/lambda-function';
import { LambdaPermission } from '@cdktn/provider-aws/lib/lambda-permission';
import { S3Bucket } from '@cdktn/provider-aws/lib/s3-bucket';
import { S3BucketLifecycleConfiguration } from '@cdktn/provider-aws/lib/s3-bucket-lifecycle-configuration';
import { S3BucketLoggingA } from '@cdktn/provider-aws/lib/s3-bucket-logging';
import { S3BucketOwnershipControls } from '@cdktn/provider-aws/lib/s3-bucket-ownership-controls';
import { S3BucketPolicy } from '@cdktn/provider-aws/lib/s3-bucket-policy';
import { S3BucketPublicAccessBlock } from '@cdktn/provider-aws/lib/s3-bucket-public-access-block';
import {
  S3BucketServerSideEncryptionConfigurationA,
} from '@cdktn/provider-aws/lib/s3-bucket-server-side-encryption-configuration';
import { SecurityGroup } from '@cdktn/provider-aws/lib/security-group';
import { SsmParameter } from '@cdktn/provider-aws/lib/ssm-parameter';
import { VpcSecurityGroupEgressRule } from '@cdktn/provider-aws/lib/vpc-security-group-egress-rule';
import { Construct } from 'constructs';
import { AwsEnv } from './aws-env';
import { UatConfig, ssmPrefix } from './config';
import { AwsccAppstreamStack, heredocSafe } from './hcl';
import { Network } from './network';

export interface DesktopProps {
  config: UatConfig;
  env: AwsEnv;
  network: Network;
}

/** The WorkSpaces Applications fleet and agent-enabled stack: infra/lib/uat-desktop-stack.ts. */
export class Desktop extends Construct {
  public readonly key: KmsKey;
  public readonly evidenceBucket: S3Bucket;
  public readonly buildsBucket: S3Bucket;
  public readonly fleetArn: string;
  public readonly stackArn: string;

  constructor(scope: Construct, id: string, props: DesktopProps) {
    super(scope, id);
    const { config: c, env, network } = props;
    const prefix = ssmPrefix(c);
    const leaseParameterName = `${prefix}/fleet-lease`;
    const arn = (service: string, resource: string) =>
      `arn:${env.partition}:${service}:${env.region}:${env.account}:${resource}`;
    this.fleetArn = arn('appstream', `fleet/${c.fleet.name}`);
    this.stackArn = arn('appstream', `stack/${c.stack.name}`);

    // ---------------------------------------------------------------- KMS
    this.key = new KmsKey(this, 'key', {
      description: 'Desktop UAT evidence and build artifacts',
      enableKeyRotation: true,
      lifecycle: { preventDestroy: true },
    });
    new KmsAlias(this, 'key_alias', { name: `alias/desktop-uat-${c.envName}`, targetKeyId: this.key.keyId });

    // ---------------------------------------------------------------- Buckets
    // No key: server access logging cannot write to an SSE-KMS bucket.
    const accessLogs = new SecureBucket(this, 'access_logs', {
      config: c, role: 'access-logs', expirationDays: 365,
      statements: [{
        sid: 'S3ServerAccessLogs',
        actions: ['s3:PutObject'],
        principals: [{ type: 'Service', identifiers: ['logging.s3.amazonaws.com'] }],
        resources: ['@OBJECTS'],
        condition: [{ test: 'StringEquals', variable: 'aws:SourceAccount', values: [env.account] }],
      }],
    });
    // As infra/ has it: the bucket owns the log objects S3 delivers into it.
    new S3BucketOwnershipControls(this, 'access_logs_ownership', {
      bucket: accessLogs.bucket.id,
      rule: { objectOwnership: 'BucketOwnerPreferred' },
    });

    // Screenshots uploaded by the agent-access service (using the agent's credentials)
    // and evidence/report files uploaded by the harness.
    this.evidenceBucket = new SecureBucket(this, 'evidence', {
      config: c, role: 'evidence', key: this.key, expirationDays: c.evidenceRetentionDays,
      accessLogs: accessLogs.bucket,
      statements: [{
        // Required by agent access: the AppStream service must be able to list the bucket.
        sid: 'AppStreamAgentAccessList',
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        principals: [{ type: 'Service', identifiers: ['appstream.amazonaws.com'] }],
        resources: ['@BUCKET'],
        condition: [{ test: 'StringEquals', variable: 'aws:SourceAccount', values: [env.account] }],
      }],
    }).bucket;

    // Staging copy of the Artifactory release under test (Artifactory stays the source of truth).
    // Readable only through the VPC's S3 gateway endpoint, i.e. by the isolated fleet
    // using a short-lived presigned URL minted by the runner.
    this.buildsBucket = new SecureBucket(this, 'builds', {
      config: c, role: 'builds', key: this.key, expirationDays: c.buildRetentionDays,
      accessLogs: accessLogs.bucket,
      statements: [{
        sid: 'DenyGetOutsideVpc',
        effect: 'Deny',
        actions: ['s3:GetObject'],
        principals: [{ type: '*', identifiers: ['*'] }],
        resources: ['@OBJECTS'],
        condition: [{ test: 'StringNotEquals', variable: 'aws:SourceVpce', values: [network.s3Endpoint.id] }],
      }],
    }).bucket;

    // ---------------------------------------------------------------- Fleet
    const fleetSg = new SecurityGroup(this, 'fleet_sg', {
      vpcId: network.vpc.id,
      name: `desktop-uat-${c.envName}-fleet`,
      description: 'UAT streaming desktops - isolated subnets, S3 gateway endpoint only',
    });
    // Isolated subnets have no default route, so 443 egress can only reach the S3 gateway endpoint.
    new VpcSecurityGroupEgressRule(this, 'fleet_https', {
      securityGroupId: fleetSg.id,
      description: 'HTTPS to S3 via gateway endpoint',
      cidrIpv4: '0.0.0.0/0',
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
    });

    const fleet = new AppstreamFleet(this, 'fleet', {
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
        subnetIds: network.subnets.fleet.map(s => s.id),
        securityGroupIds: [fleetSg.id],
      },
      maxUserDurationInSeconds: c.fleet.maxSessionSeconds,
      disconnectTimeoutInSeconds: 60,
      idleDisconnectTimeoutInSeconds: 900,
    });

    // ---------------------------------------------------------------- Agent-enabled stack
    // awscc, not aws: only the Cloud Control provider has agent_access_config.
    const stack = new AwsccAppstreamStack(this, 'agent_stack', {
      name: c.stack.name,
      displayName: `Desktop UAT agents (${c.envName})`,
      description: 'Agent access stack for agentic UAT. Not for human users.',
      agentAccessConfig: {
        screenResolution: 'W_1280xH_720',
        screenImageFormat: c.stack.screenImageFormat,
        userControlMode: c.stack.userControlMode,
        screenshotsUploadEnabled: true,
        s3BucketArn: this.evidenceBucket.arn,
        settings: [
          { agentAction: 'COMPUTER_VISION', permission: 'ENABLED' },
          { agentAction: 'COMPUTER_INPUT', permission: 'ENABLED' },
          { agentAction: 'FORWARD_MCP_TOOLS', permission: 'ENABLED' },
        ],
      },
    });

    // By reference, so Terraform creates it after both.
    new AppstreamFleetStackAssociation(this, 'association', { fleetName: fleet.name, stackName: stack.name });

    // ---------------------------------------------------------------- Optional image builder
    if (c.createImageBuilder) {
      const ibSg = new SecurityGroup(this, 'image_builder_sg', {
        vpcId: network.vpc.id,
        name: `desktop-uat-${c.envName}-image-builder`,
        description: 'Image builder - needs egress to install dependencies',
      });
      new VpcSecurityGroupEgressRule(this, 'image_builder_egress', {
        securityGroupId: ibSg.id, cidrIpv4: '0.0.0.0/0', ipProtocol: '-1',
      });
      new AppstreamImageBuilder(this, 'image_builder', {
        name: `desktop-uat-ib-${c.envName}`,
        instanceType: 'stream.standard.large',
        imageName: c.imageBuilderBaseImage,
        enableDefaultInternetAccess: false,
        vpcConfig: { subnetIds: [network.subnets.runners[0].id], securityGroupIds: [ibSg.id] },
      });
    }

    // ---------------------------------------------------------------- Lease parameter
    // The workflow writes an expiry epoch here while it needs the fleet; the janitor
    // will not stop a fleet whose lease is still valid. Terraform creates it and then
    // leaves its value alone: an apply must never cancel a lease a run is holding.
    new SsmParameter(this, 'lease', {
      name: leaseParameterName,
      type: 'String',
      value: '0',
      description: 'Epoch seconds until which a workflow holds the UAT fleet',
      lifecycle: { ignoreChanges: ['value'] },
    });

    this.janitor(c, arn, leaseParameterName);

    // ---------------------------------------------------------------- Discovery parameters
    // The workflow and harness read everything from SSM; nothing is hard-coded in YAML.
    const params: Record<string, string> = {
      'region': env.region,
      'fleet-name': c.fleet.name,
      'stack-name': c.stack.name,
      'evidence-bucket': this.evidenceBucket.bucket,
      'builds-bucket': this.buildsBucket.bucket,
      'mcp-endpoint': `https://agentaccess-mcp.${env.region}.api.aws/mcp`,
      'bedrock-model-id': c.bedrockModelId,
      'max-concurrent-sessions': String(c.fleet.maxConcurrentSessions),
    };
    for (const [k, v] of Object.entries(params)) {
      new SsmParameter(this, `param_${k.replace(/-/g, '_')}`, { name: `${prefix}/${k}`, type: 'String', value: v });
    }
  }

  // ---------------------------------------------------------------- Fleet janitor
  private janitor(c: UatConfig, arn: (service: string, resource: string) => string, leaseParameterName: string) {
    const functionName = `desktop-uat-${c.envName}-fleet-janitor`;
    const logs = new CloudwatchLogGroup(this, 'janitor_logs', { name: `/aws/lambda/${functionName}`, retentionInDays: 90 });

    const assume = new DataAwsIamPolicyDocument(this, 'janitor_assume', {
      statement: [{ actions: ['sts:AssumeRole'], principals: [{ type: 'Service', identifiers: ['lambda.amazonaws.com'] }] }],
    });
    const role = new IamRole(this, 'janitor_role', { namePrefix: 'desktop-uat-janitor-', assumeRolePolicy: assume.json });
    const permissions = new DataAwsIamPolicyDocument(this, 'janitor_permissions', {
      statement: [
        { sid: 'Logs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${logs.arn}:*`] },
        { sid: 'Describe', actions: ['appstream:DescribeFleets', 'appstream:DescribeSessions'], resources: ['*'] },
        { sid: 'StopFleet', actions: ['appstream:StopFleet'], resources: [arn('appstream', `fleet/${c.fleet.name}`)] },
        { sid: 'Lease', actions: ['ssm:GetParameter'], resources: [arn('ssm', `parameter${leaseParameterName}`)] },
      ],
    });
    new IamRolePolicy(this, 'janitor_policy', { role: role.name, policy: permissions.json });

    // Packed at plan time from the code below, so the configuration carries it inline,
    // as infra/'s template does: no build step, and only the SDK the runtime provides.
    const code = new DataArchiveFile(this, 'janitor_code', {
      type: 'zip',
      outputPath: '${path.module}/.build/fleet-janitor.zip',
      source: [{ filename: 'index.js', content: heredocSafe(JANITOR_CODE) }],
    });

    const fn = new LambdaFunction(this, 'janitor', {
      functionName,
      description: 'Stops the UAT fleet when idle and unleased (cost safety net)',
      role: role.arn,
      runtime: 'nodejs24.x',
      handler: 'index.handler',
      timeout: 60,
      filename: code.outputPath,
      sourceCodeHash: code.outputBase64Sha256,
      loggingConfig: { logFormat: 'Text', logGroup: logs.name },
      environment: {
        variables: { FLEET_NAME: c.fleet.name, STACK_NAME: c.stack.name, LEASE_PARAM: leaseParameterName },
      },
    });

    const schedule = new CloudwatchEventRule(this, 'janitor_schedule', {
      name: `${functionName}-schedule`,
      scheduleExpression: `rate(${Math.max(15, Math.floor(c.janitorIdleMinutes / 3))} minutes)`,
    });
    new CloudwatchEventTarget(this, 'janitor_target', { rule: schedule.name, arn: fn.arn });
    new LambdaPermission(this, 'janitor_invoke', {
      action: 'lambda:InvokeFunction',
      functionName: fn.functionName,
      principal: 'events.amazonaws.com',
      sourceArn: schedule.arn,
    });
  }
}

const JANITOR_CODE = `const { AppStreamClient, DescribeFleetsCommand, DescribeSessionsCommand, StopFleetCommand } = require('@aws-sdk/client-appstream');
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
};`;

interface SecureBucketProps {
  config: UatConfig;
  /** Part of the bucket's name: desktop-uat-<env>-<role>-<suffix>. */
  role: string;
  /** SSE-KMS with this key; S3-managed keys when absent. */
  key?: KmsKey;
  accessLogs?: S3Bucket;
  expirationDays: number;
  /** Extra policy statements. "@BUCKET" and "@OBJECTS" stand for this bucket's ARNs. */
  statements?: DataAwsIamPolicyDocumentStatement[];
}

/**
 * A private bucket the way the CDK's s3.Bucket makes one here: public access
 * blocked, TLS only, encrypted, expiring, and kept when the stack is destroyed.
 */
class SecureBucket extends Construct {
  public readonly bucket: S3Bucket;

  constructor(scope: Construct, id: string, props: SecureBucketProps) {
    super(scope, id);
    const bucket = this.bucket = new S3Bucket(this, 'bucket', {
      bucketPrefix: `desktop-uat-${props.config.envName}-${props.role}-`,
      lifecycle: { preventDestroy: true },
    });

    const publicAccess = new S3BucketPublicAccessBlock(this, 'public_access', {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });

    new S3BucketServerSideEncryptionConfigurationA(this, 'encryption', {
      bucket: bucket.id,
      rule: [props.key
        ? { applyServerSideEncryptionByDefault: { sseAlgorithm: 'aws:kms', kmsMasterKeyId: props.key.arn }, bucketKeyEnabled: true }
        : { applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
    });

    new S3BucketLifecycleConfiguration(this, 'expiry', {
      bucket: bucket.id,
      rule: [{ id: 'expire', status: 'Enabled', filter: [{}], expiration: [{ days: props.expirationDays }] }],
    });

    if (props.accessLogs) {
      new S3BucketLoggingA(this, 'logging', {
        bucket: bucket.id,
        targetBucket: props.accessLogs.id,
        targetPrefix: `${props.role}/`,
      });
    }

    const resolve = (r: string) => (r === '@BUCKET' ? bucket.arn : r === '@OBJECTS' ? `${bucket.arn}/*` : r);
    const policy = new DataAwsIamPolicyDocument(this, 'policy_document', {
      statement: [
        {
          sid: 'DenyInsecureTransport',
          effect: 'Deny',
          actions: ['s3:*'],
          principals: [{ type: '*', identifiers: ['*'] }],
          resources: [bucket.arn, `${bucket.arn}/*`],
          condition: [{ test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }],
        },
        ...(props.statements ?? []).map(s => ({ ...s, resources: (s.resources ?? []).map(resolve) })),
      ],
    });
    // After the public access block: S3 rejects the two changed concurrently.
    new S3BucketPolicy(this, 'policy', { bucket: bucket.id, policy: policy.json, dependsOn: [publicAccess] });
  }
}
