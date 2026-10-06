import { AutoscalingGroup } from '@cdktn/provider-aws/lib/autoscaling-group';
import { DataAwsIamPolicyDocument } from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { IamInstanceProfile } from '@cdktn/provider-aws/lib/iam-instance-profile';
import { IamRole } from '@cdktn/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktn/provider-aws/lib/iam-role-policy';
import { IamRolePolicyAttachment } from '@cdktn/provider-aws/lib/iam-role-policy-attachment';
import { LaunchTemplate } from '@cdktn/provider-aws/lib/launch-template';
import { SecurityGroup } from '@cdktn/provider-aws/lib/security-group';
import { VpcSecurityGroupEgressRule } from '@cdktn/provider-aws/lib/vpc-security-group-egress-rule';
import { Fn } from 'cdktn';
import { Construct } from 'constructs';
import { AwsEnv } from './aws-env';
import { UatConfig, ssmPrefix } from './config';
import { Desktop } from './desktop';
import { HeredocLocal } from './hcl';
import { Network } from './network';

export interface RunnersProps {
  config: UatConfig;
  env: AwsEnv;
  network: Network;
  desktop: Desktop;
}

/**
 * Ephemeral GHES runners (one job per registration) in the runner tier:
 * infra/lib/runner-stack.ts.
 *
 * AWS credentials come from the instance profile, not GitHub OIDC: STS has to
 * fetch the OIDC issuer's JWKS over the internet, which a private GHES usually
 * can't offer. If your GHES is internet-reachable, you can switch to OIDC.
 */
export class Runners extends Construct {
  public readonly role: IamRole;

  constructor(scope: Construct, id: string, props: RunnersProps) {
    super(scope, id);
    const { config: c, env, network, desktop } = props;
    const prefix = ssmPrefix(c);
    const p = env.partition;
    const ssmArn = (name: string) => `arn:${p}:ssm:${env.region}:${env.account}:parameter${name}`;
    // Secrets are created out of band; Secrets Manager appends six random characters to the name.
    const secretArn = (name: string) => `arn:${p}:secretsmanager:${env.region}:${env.account}:secret:${name}-??????`;

    const assume = new DataAwsIamPolicyDocument(this, 'assume', {
      statement: [{ actions: ['sts:AssumeRole'], principals: [{ type: 'Service', identifiers: ['ec2.amazonaws.com'] }] }],
    });
    this.role = new IamRole(this, 'role', {
      namePrefix: 'desktop-uat-runner-',
      description: 'GHES desktop-UAT runner: drives WorkSpaces agent sessions',
      assumeRolePolicy: assume.json,
    });
    new IamRolePolicyAttachment(this, 'ssm_core', {
      role: this.role.name,
      policyArn: `arn:${p}:iam::aws:policy/AmazonSSMManagedInstanceCore`,
    });

    const buckets = [desktop.evidenceBucket, desktop.buildsBucket];
    const permissions = new DataAwsIamPolicyDocument(this, 'permissions', {
      statement: [
        // WorkSpaces Applications: session URLs + fleet lifecycle, scoped to our fleet/stack.
        { sid: 'StreamingUrl', actions: ['appstream:CreateStreamingURL'], resources: [desktop.stackArn, desktop.fleetArn] },
        { sid: 'FleetLifecycle', actions: ['appstream:StartFleet', 'appstream:StopFleet'], resources: [desktop.fleetArn] },
        {
          sid: 'Describe',
          actions: ['appstream:DescribeFleets', 'appstream:DescribeStacks', 'appstream:DescribeSessions'],
          resources: ['*'],
        },
        // Agent-access MCP endpoint (SigV4 service "agentaccess-mcp").
        { sid: 'AgentAccessMcp', actions: ['agentaccess-mcp:*'], resources: ['*'] },
        // Cross-region/global inference profiles route to foundation models in other regions.
        {
          sid: 'Bedrock',
          actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: [
            `arn:${p}:bedrock:*::foundation-model/anthropic.*`,
            `arn:${p}:bedrock:*:${env.account}:inference-profile/*`,
          ],
        },
        // Screenshots are uploaded by the agent-access service with *these* credentials.
        // The same actions as the CDK's bucket.grantReadWrite.
        {
          sid: 'Buckets',
          actions: [
            's3:GetObject*', 's3:GetBucket*', 's3:List*', 's3:DeleteObject*', 's3:PutObject',
            's3:PutObjectLegalHold', 's3:PutObjectRetention', 's3:PutObjectTagging',
            's3:PutObjectVersionTagging', 's3:Abort*',
          ],
          resources: buckets.flatMap(b => [b.arn, `${b.arn}/*`]),
        },
        {
          sid: 'Key',
          actions: ['kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'],
          resources: [desktop.key.arn],
        },
        // SSM: discovery params, fleet lease, observer links (SecureString).
        {
          sid: 'SsmRead',
          actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
          resources: [ssmArn(`${prefix}/*`)],
        },
        {
          sid: 'SsmWrite',
          actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
          resources: [ssmArn(`${prefix}/fleet-lease`), ssmArn(`${prefix}/observe/*`)],
        },
        // The GHES registration token, and the read-only Artifactory token that pulls the release.
        {
          sid: 'Secrets',
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [secretArn(c.runner.tokenSecretName), secretArn(c.artifactory.tokenSecretName)],
        },
      ],
    });
    new IamRolePolicy(this, 'policy', { role: this.role.name, policy: permissions.json });
    const profile = new IamInstanceProfile(this, 'profile', { namePrefix: 'desktop-uat-runner-', role: this.role.name });

    // --- Network
    const sg = new SecurityGroup(this, 'sg', {
      vpcId: network.vpc.id,
      name: `desktop-uat-${c.envName}-runners`,
      description: 'GHES runners - HTTPS egress only, no ingress',
    });
    new VpcSecurityGroupEgressRule(this, 'https', {
      securityGroupId: sg.id,
      description: 'HTTPS: MCP endpoint, GHES, Artifactory, package mirrors',
      cidrIpv4: '0.0.0.0/0',
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
    });

    // --- Instances
    // A local, so the HCL shows the script as a heredoc rather than one escaped line.
    const script = new HeredocLocal(this, 'user_data', userData(c, env));

    const lt = new LaunchTemplate(this, 'lt', {
      namePrefix: `desktop-uat-${c.envName}-runner-`,
      // Resolved by EC2 at each launch, so instances get the current AL2023 without a re-plan.
      imageId: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      instanceType: c.runner.instanceType,
      iamInstanceProfile: { arn: profile.arn },
      vpcSecurityGroupIds: [sg.id],
      userData: Fn.base64encode(script.asString),
      metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
      blockDeviceMappings: [{
        deviceName: '/dev/xvda',
        ebs: { volumeSize: 50, volumeType: 'gp3', encrypted: 'true' },
      }],
      tagSpecifications: [{ resourceType: 'instance', tags: { Name: `desktop-uat-${c.envName}-runner` } }],
    });

    new AutoscalingGroup(this, 'asg', {
      namePrefix: `desktop-uat-${c.envName}-runners-`,
      vpcZoneIdentifier: network.subnets.runners.map(s => s.id),
      minSize: c.runner.minCapacity,
      maxSize: c.runner.maxCapacity,
      healthCheckType: 'EC2',
      launchTemplate: { id: lt.id, version: lt.latestVersion.toString() },
      instanceRefresh: { strategy: 'Rolling', preferences: { minHealthyPercentage: 50 } },
    });
  }
}

/**
 * The same boot script as infra/'s runner stack: the env file, the runner loop,
 * its unit. Its heredocs are not called EOF, which would end the HCL's own.
 */
function userData(c: UatConfig, env: AwsEnv): string {
  const ghes = c.runner.ghesUrl.replace(/\/$/, '');
  const runnerUrl = c.runner.runnerDownloadUrl ||
    `https://github.com/actions/runner/releases/download/v${c.runner.runnerVersion}/actions-runner-linux-x64-${c.runner.runnerVersion}.tar.gz`;
  const registrationUrl = `${ghes}/${c.runner.target}`;
  const tokenEndpoint = c.runner.scope === 'org'
    ? `${ghes}/api/v3/orgs/${c.runner.target}/actions/runners/registration-token`
    : `${ghes}/api/v3/repos/${c.runner.target}/actions/runners/registration-token`;

  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'dnf install -y -q git jq tar gzip libicu python3.11 python3.11-pip',
    'id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner',
    'mkdir -p /opt/actions-runner && chown runner:runner /opt/actions-runner',
    `curl -fsSL -o /opt/actions-runner/runner.tar.gz "${runnerUrl}"`,
    'chown runner:runner /opt/actions-runner/runner.tar.gz',
    `cat > /etc/desktop-uat-runner.env <<'ENV'`,
    `REGION=${env.region}`,
    `SECRET_ID=${c.runner.tokenSecretName}`,
    `TOKEN_ENDPOINT=${tokenEndpoint}`,
    `REGISTRATION_URL=${registrationUrl}`,
    `LABELS=${c.runner.labels.filter(l => l !== 'self-hosted').join(',')}`,
    `UAT_SSM_PREFIX=${ssmPrefix(c)}`,
    `ARTIFACTORY_URL=${c.artifactory.baseUrl}`,
    `ARTIFACTORY_SECRET_ID=${c.artifactory.tokenSecretName}`,
    'ENV',
    `cat > /opt/actions-runner/loop.sh <<'LOOP'`,
    '#!/bin/bash',
    '# One ephemeral registration per job; fresh workspace every time.',
    'set -uo pipefail',
    'source /etc/desktop-uat-runner.env',
    'while true; do',
    '  TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text | jq -r .token)',
    '  REG=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$TOKEN_ENDPOINT" | jq -r .token)',
    '  unset TOKEN',
    '  if [ -z "$REG" ] || [ "$REG" = "null" ]; then echo "registration token request failed"; sleep 60; continue; fi',
    '  WORK=$(mktemp -d /opt/actions-runner/run.XXXXXX)',
    '  tar xzf /opt/actions-runner/runner.tar.gz -C "$WORK"',
    '  cd "$WORK"',
    '  ./config.sh --unattended --ephemeral --replace --url "$REGISTRATION_URL" --token "$REG" \\',
    '    --labels "$LABELS" --name "uat-$(hostname -s)-$(date +%s)" --work _work || { sleep 30; cd /; rm -rf "$WORK"; continue; }',
    '  ./run.sh',
    '  cd / && rm -rf "$WORK"',
    'done',
    'LOOP',
    'chmod 0755 /opt/actions-runner/loop.sh',
    `cat > /etc/systemd/system/actions-runner.service <<'UNIT'`,
    '[Unit]',
    'Description=GHES ephemeral runner loop (desktop UAT)',
    'After=network-online.target',
    'Wants=network-online.target',
    '[Service]',
    'User=runner',
    'Environment=UAT_PYTHON=/usr/bin/python3.11',
    'ExecStart=/opt/actions-runner/loop.sh',
    'Restart=always',
    'RestartSec=10',
    '[Install]',
    'WantedBy=multi-user.target',
    'UNIT',
    'systemctl daemon-reload',
    'systemctl enable --now actions-runner.service',
    '',
  ].join('\n');
}
