/**
 * The seams between the CDK and everything that runs against what it deploys.
 *
 * The harness, the workflow and the scripts never see the stacks: they find
 * their resources through SSM parameters and /etc/desktop-uat-runner.env, and
 * act with the runner role's permissions. Each side can be right on its own and
 * the pair still broken — a renamed parameter, a missing grant — and nothing
 * fails until a real run on AWS. These tests read the other side's source and
 * hold the two together.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UatConfig, ssmPrefix } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { RunnerStack } from '../lib/runner-stack';
import { UatDesktopStack } from '../lib/uat-desktop-stack';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config: UatConfig = require('../cdk.json').context.uat;
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const prefix = ssmPrefix(config);

const app = new cdk.App();
const env = { account: '111122223333', region: 'ap-southeast-2' };
const net = new NetworkStack(app, 'N', { env, config });
const desk = new UatDesktopStack(app, 'D', { env, config, vpc: net.vpc, s3Endpoint: net.s3Endpoint });
const run = new RunnerStack(app, 'R', {
  env, config, vpc: net.vpc, key: desk.key,
  evidenceBucket: desk.evidenceBucket, buildsBucket: desk.buildsBucket,
  fleetArn: desk.fleetArn(config.fleet.name), stackArn: desk.stackArn(config.stack.name),
});
const deskT = Template.fromStack(desk);
const runT = Template.fromStack(run);

const statements = (t: Template): any[] =>
  Object.values(t.findResources('AWS::IAM::Policy'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
const asList = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);
const allows = (stmts: any[], action: string, resourceSuffix: string) =>
  stmts.some(s => s.Effect === 'Allow'
    && asList(s.Action).some((a: string) => a === action || (a.endsWith('*') && action.startsWith(a.slice(0, -1))))
    && asList(s.Resource).some((r: any) => JSON.stringify(r).includes(resourceSuffix)));

const ssmNames = Object.values(deskT.findResources('AWS::SSM::Parameter'))
  .map((p: any) => p.Properties.Name as string);

const matches = (src: string, re: RegExp) => [...src.matchAll(re)].map(m => m[1]);

// ----------------------------------------------------------------- SSM discovery
describe('every SSM parameter a consumer reads is one the Desktop stack writes', () => {
  const consumers: Record<string, string[]> = {
    'harness/uat_harness/config.py': matches(read('harness/uat_harness/config.py'), /need\("([^"]+)"\)/g),
    'scripts/fleet.sh': matches(read('scripts/fleet.sh'), /param ([a-z-]+)/g),
    'scripts/stage-from-artifactory.sh':
      matches(read('scripts/stage-from-artifactory.sh'), /\$UAT_SSM_PREFIX\/([a-z-]+)/g),
  };

  test.each(Object.entries(consumers))('%s', (_file, keys) => {
    expect(keys.length).toBeGreaterThan(0); // the regex still finds them
    for (const k of keys) expect(ssmNames).toContain(`${prefix}/${k}`);
  });

  test('the janitor reads the lease from the same parameter fleet.sh writes', () => {
    expect(read('scripts/fleet.sh')).toContain('$UAT_SSM_PREFIX/fleet-lease');
    expect(ssmNames).toContain(`${prefix}/fleet-lease`);
  });
});

// ----------------------------------------------------------------- the runner's environment
describe('the runner provides what the workflow assumes', () => {
  const workflow = read('.github/workflows/desktop-uat.yml');
  const userData = JSON.stringify(Object.values(runT.findResources('AWS::EC2::LaunchTemplate'))[0]);

  test('every key the workflow loads from /etc/desktop-uat-runner.env is written by user data', () => {
    const grep = workflow.match(/grep -E '\^\(([A-Z_|]+)\)='/);
    expect(grep).not.toBeNull();
    for (const key of grep![1].split('|')) expect(userData).toContain(`${key}=`);
  });

  test('jobs run on exactly the labels the runners register with', () => {
    const runsOn = matches(workflow, /runs-on: \[([^\]]+)\]/g);
    expect(runsOn.length).toBeGreaterThan(0);
    for (const labels of runsOn) {
      expect(labels.split(',').map(l => l.trim()).sort()).toEqual([...config.runner.labels].sort());
    }
  });

  test('the tools the scripts call are installed', () => {
    // stage-from-artifactory.sh uses jq; the workflow's Python step uses python3.11.
    expect(userData).toMatch(/dnf install[^"]*\bjq\b/);
    expect(userData).toMatch(/dnf install[^"]*\bpython3\.11\b/);
    expect(userData).toContain('UAT_PYTHON=/usr/bin/python3.11');
  });
});

// ----------------------------------------------------------------- the runner's permissions
describe('the runner role can do what the scripts and harness do', () => {
  const s = statements(runT);

  test.each([
    // [action, resource it must cover, who needs it]
    ['ssm:GetParameter', `parameter${prefix}/*`, 'fleet.sh, stage-from-artifactory.sh'],
    ['ssm:GetParametersByPath', `parameter${prefix}/*`, 'HarnessConfig.from_ssm'],
    ['ssm:PutParameter', `parameter${prefix}/fleet-lease`, 'fleet.sh lease/release'],
    ['ssm:PutParameter', `parameter${prefix}/observe/*`, 'runner._publish_observer_link'],
    ['appstream:StartFleet', `fleet/${config.fleet.name}`, 'fleet.sh start'],
    ['appstream:StopFleet', `fleet/${config.fleet.name}`, 'fleet.sh stop'],
    ['appstream:DescribeFleets', '*', 'fleet.sh state'],
    ['appstream:CreateStreamingURL', `stack/${config.stack.name}`, 'DesktopSession'],
    ['bedrock:InvokeModel', 'inference-profile/*', 'run_agent'],
    ['secretsmanager:GetSecretValue', config.artifactory.tokenSecretName, 'stage-from-artifactory.sh'],
  ])('%s on %s (%s)', (action, resource) => {
    expect(allows(s, action, resource)).toBe(true);
  });

  test('s3 put on both buckets (staging the build, uploading evidence)', () => {
    const puts = s.filter(st => asList(st.Action).some((a: string) => a.startsWith('s3:PutObject')));
    const res = JSON.stringify(puts);
    for (const bucket of [desk.buildsBucket, desk.evidenceBucket]) {
      expect(res).toContain(desk.getLogicalId(bucket.node.defaultChild as cdk.CfnElement));
    }
  });

  test('the role cannot write discovery parameters it only reads', () => {
    const writes = s.filter(st => asList(st.Action).includes('ssm:PutParameter'));
    expect(JSON.stringify(writes)).not.toContain(`${prefix}/*`);
  });
});

// ----------------------------------------------------------------- the model
test('the configured Bedrock model is a profile the runner may invoke', () => {
  // The default is a cross-region (global./au./us.) inference profile; the policy
  // covers inference-profile/* in this account and anthropic.* foundation models.
  expect(config.bedrockModelId).toMatch(/^(global|au|us|eu|apac)\.anthropic\.|^anthropic\./);
});
