import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { UatConfig, ssmPrefix } from './config';

export interface RunnerStackProps extends cdk.StackProps {
  config: UatConfig;
  vpc: ec2.IVpc;
  key: kms.IKey;
  evidenceBucket: s3.IBucket;
  buildsBucket: s3.IBucket;
  fleetArn: string;
  stackArn: string;
}

/**
 * Ephemeral GHES runners (one job per registration) in private subnets.
 *
 * AWS credentials come from the instance profile, not GitHub OIDC: STS has to
 * fetch the OIDC issuer's JWKS over the internet, which a private GHES usually
 * can't offer. If your GHES is internet-reachable, you can switch to OIDC.
 */
export class RunnerStack extends cdk.Stack {
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: RunnerStackProps) {
    super(scope, id, props);
    const c = props.config;
    const prefix = ssmPrefix(c);

    const tokenSecret = secretsmanager.Secret.fromSecretNameV2(this, 'RunnerToken', c.runner.tokenSecretName);
    const artifactorySecret = secretsmanager.Secret.fromSecretNameV2(this, 'ArtifactoryToken', c.artifactory.tokenSecretName);

    this.role = new iam.Role(this, 'RunnerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'GHES desktop-UAT runner: drives WorkSpaces agent sessions',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    const r = this.role;

    // --- WorkSpaces Applications: session URLs + fleet lifecycle, scoped to our fleet/stack.
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'StreamingUrl',
      actions: ['appstream:CreateStreamingURL'],
      resources: [props.stackArn, props.fleetArn],
    }));
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'FleetLifecycle',
      actions: ['appstream:StartFleet', 'appstream:StopFleet'],
      resources: [props.fleetArn],
    }));
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'Describe',
      actions: ['appstream:DescribeFleets', 'appstream:DescribeStacks', 'appstream:DescribeSessions'],
      resources: ['*'],
    }));

    // --- Agent-access MCP endpoint (SigV4 service "agentaccess-mcp").
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'AgentAccessMcp',
      actions: ['agentaccess-mcp:*'],
      resources: ['*'],
    }));

    // --- Bedrock. Cross-region/global inference profiles route to foundation models in other regions.
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'Bedrock',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        `arn:${this.partition}:bedrock:*::foundation-model/anthropic.*`,
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    // --- Buckets. Screenshots are uploaded by the agent-access service with *these* credentials.
    props.evidenceBucket.grantReadWrite(r);
    props.buildsBucket.grantReadWrite(r);
    props.key.grantEncryptDecrypt(r);

    // --- SSM: discovery params, fleet lease, observer links (SecureString).
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmRead',
      actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}/*`],
    }));
    r.addToPolicy(new iam.PolicyStatement({
      sid: 'SsmWrite',
      actions: ['ssm:PutParameter', 'ssm:DeleteParameter'],
      resources: [
        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}/fleet-lease`,
        `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${prefix}/observe/*`,
      ],
    }));

    tokenSecret.grantRead(r);
    // Read-only Artifactory token used to pull the release under test.
    artifactorySecret.grantRead(r);

    // --- Network
    const sg = new ec2.SecurityGroup(this, 'RunnerSg', {
      vpc: props.vpc,
      allowAllOutbound: false,
      description: 'GHES runners - HTTPS egress only, no ingress',
    });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS: MCP endpoint, GHES, Artifactory, package mirrors');

    // --- Instances
    const runnerUrl = c.runner.runnerDownloadUrl ||
      `https://github.com/actions/runner/releases/download/v${c.runner.runnerVersion}/actions-runner-linux-x64-${c.runner.runnerVersion}.tar.gz`;
    const registrationUrl = `${c.runner.ghesUrl.replace(/\/$/, '')}/${c.runner.target}`;
    const tokenEndpoint = c.runner.scope === 'org'
      ? `${c.runner.ghesUrl.replace(/\/$/, '')}/api/v3/orgs/${c.runner.target}/actions/runners/registration-token`
      : `${c.runner.ghesUrl.replace(/\/$/, '')}/api/v3/repos/${c.runner.target}/actions/runners/registration-token`;

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -euo pipefail',
      'dnf install -y -q git jq tar gzip libicu python3.11 python3.11-pip',
      'id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner',
      'mkdir -p /opt/actions-runner && chown runner:runner /opt/actions-runner',
      `curl -fsSL -o /opt/actions-runner/runner.tar.gz "${runnerUrl}"`,
      'chown runner:runner /opt/actions-runner/runner.tar.gz',
      `cat > /etc/desktop-uat-runner.env <<'EOF'`,
      `REGION=${this.region}`,
      `SECRET_ID=${c.runner.tokenSecretName}`,
      `TOKEN_ENDPOINT=${tokenEndpoint}`,
      `REGISTRATION_URL=${registrationUrl}`,
      `LABELS=${c.runner.labels.filter(l => l !== 'self-hosted').join(',')}`,
      `UAT_SSM_PREFIX=${prefix}`,
      `ARTIFACTORY_URL=${c.artifactory.baseUrl}`,
      `ARTIFACTORY_SECRET_ID=${c.artifactory.tokenSecretName}`,
      'EOF',
      `cat > /opt/actions-runner/loop.sh <<'EOF'`,
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
      'EOF',
      'chmod 0755 /opt/actions-runner/loop.sh',
      `cat > /etc/systemd/system/actions-runner.service <<'EOF'`,
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
      'EOF',
      'systemctl daemon-reload',
      'systemctl enable --now actions-runner.service',
    );

    const lt = new ec2.LaunchTemplate(this, 'RunnerLt', {
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      instanceType: new ec2.InstanceType(c.runner.instanceType),
      role: this.role,
      securityGroup: sg,
      userData,
      requireImdsv2: true,
      httpPutResponseHopLimit: 1,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(50, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }),
      }],
    });

    new autoscaling.AutoScalingGroup(this, 'Runners', {
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: 'runners' },
      launchTemplate: lt,
      minCapacity: c.runner.minCapacity,
      maxCapacity: c.runner.maxCapacity,
      healthChecks: autoscaling.HealthChecks.ec2(),
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
    });
  }
}
