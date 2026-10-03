import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { UatConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { RunnerStack } from '../lib/runner-stack';
import { UatDesktopStack } from '../lib/uat-desktop-stack';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config: UatConfig = require('../cdk.json').context.uat;

function build() {
  const app = new cdk.App();
  const env = { account: '111122223333', region: 'ap-southeast-2' };
  const net = new NetworkStack(app, 'N', { env, config });
  const desk = new UatDesktopStack(app, 'D', { env, config, vpc: net.vpc, s3Endpoint: net.s3Endpoint });
  const run = new RunnerStack(app, 'R', {
    env, config, vpc: net.vpc, key: desk.key,
    evidenceBucket: desk.evidenceBucket, buildsBucket: desk.buildsBucket,
    fleetArn: desk.fleetArn(config.fleet.name), stackArn: desk.stackArn(config.stack.name),
  });
  return { net: Template.fromStack(net), desk: Template.fromStack(desk), run: Template.fromStack(run) };
}

const t = build();

test('stack enables agent access with VIEW_STOP, screenshots and MCP forwarding', () => {
  t.desk.hasResourceProperties('AWS::AppStream::Stack', {
    AgentAccessConfig: Match.objectLike({
      UserControlMode: 'VIEW_STOP',
      ScreenResolution: 'W_1280xH_720',
      ScreenshotsUploadEnabled: true,
      Settings: Match.arrayWith([
        { AgentAction: 'COMPUTER_VISION', Permission: 'ENABLED' },
        { AgentAction: 'COMPUTER_INPUT', Permission: 'ENABLED' },
        { AgentAction: 'FORWARD_MCP_TOOLS', Permission: 'ENABLED' },
      ]),
    }),
  });
});

test('fleet is on-demand, desktop view, no internet', () => {
  t.desk.hasResourceProperties('AWS::AppStream::Fleet', {
    FleetType: 'ON_DEMAND',
    StreamView: 'DESKTOP',
    EnableDefaultInternetAccess: false,
    VpcConfig: Match.objectLike({ SubnetIds: Match.anyValue() }),
  });
});

test('association depends on fleet and stack', () => {
  const assoc = t.desk.findResources('AWS::AppStream::StackFleetAssociation');
  const deps = Object.values(assoc)[0].DependsOn as string[];
  expect(deps.length).toBe(2);
});

test('fleet subnets are isolated (no NAT route)', () => {
  const routes = t.net.findResources('AWS::EC2::Route', {
    Properties: { NatGatewayId: Match.anyValue() },
  });
  const isolatedTables = Object.keys(t.net.findResources('AWS::EC2::RouteTable'))
    .filter(k => k.includes('fleet'));
  for (const r of Object.values(routes)) {
    const rt = (r as any).Properties.RouteTableId.Ref as string;
    expect(isolatedTables).not.toContain(rt);
  }
});

test('runner can mint streaming URLs only for its stack/fleet and call agent-access MCP', () => {
  const policies = Object.values(t.run.findResources('AWS::IAM::Policy'));
  const stmts = policies.flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const byId = (sid: string) => stmts.find((s: any) => s.Sid === sid);
  expect(byId('AgentAccessMcp').Action).toBe('agentaccess-mcp:*');
  const url = byId('StreamingUrl');
  expect(url.Action).toBe('appstream:CreateStreamingURL');
  expect(url.Resource).toHaveLength(2); // stack ARN + fleet ARN, never '*'
  expect(JSON.stringify(url.Resource)).toContain('stack/desktop-uat-agent-stack');
});

test('runner can read the Artifactory token secret', () => {
  const policies = Object.values(t.run.findResources('AWS::IAM::Policy'));
  const json = JSON.stringify(policies);
  expect(json).toContain('desktop-uat/artifactory-token');
});

test('runner launch template enforces IMDSv2 and encrypted root volume', () => {
  t.run.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      MetadataOptions: Match.objectLike({ HttpTokens: 'required' }),
      BlockDeviceMappings: Match.arrayWith([Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true }) })]),
    }),
  });
});
