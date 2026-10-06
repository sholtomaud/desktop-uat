/**
 * The seams between this configuration and everything that runs against what it
 * deploys — the same contracts infra/test/contracts.test.ts holds the CDK to
 * (AGENTS.md §6). The harness, the workflow and the scripts never see either IaC:
 * they find resources through SSM and /etc/desktop-uat-runner.env, and act with
 * the runner role. These tests read the other side's source.
 */
import * as fs from 'fs';
import * as path from 'path';
import { allows, config, asList, only, ref, resources, roleStatements, synth } from './support';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const prefix = `/desktop-uat/${config.envName}`;
const matches = (src: string, re: RegExp) => [...src.matchAll(re)].map(m => m[1]);

const { tf } = synth();
const ssmNames = (Object.values(resources(tf, 'aws_ssm_parameter')) as any[]).map(p => p.name as string);
const [, lt] = only(tf, 'aws_launch_template');
const runnerRole = Object.keys(resources(tf, 'aws_iam_role')).find(n => n.startsWith('runners_'))!;
const s = roleStatements(tf, runnerRole);

// user_data is base64encode(local.runners_user_data): the script is that local.
expect(lt.user_data).toBe('${base64encode(local.runners_user_data)}');
const userData: string = tf.locals.runners_user_data;

describe('every SSM parameter a consumer reads is one this configuration writes', () => {
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

describe('the runner provides what the workflow assumes', () => {
  const workflow = read('.github/workflows/desktop-uat.yml');

  test('every key the workflow loads from /etc/desktop-uat-runner.env is written by user data', () => {
    const grep = workflow.match(/grep -E '\^\(([A-Z_|]+)\)='/);
    expect(grep).not.toBeNull();
    for (const key of grep![1].split('|')) expect(userData).toMatch(new RegExp(`^${key}=`, 'm'));
  });

  test('the env file names the region, the SSM prefix and both secrets', () => {
    expect(userData).toContain(`\nREGION=${config.region}\n`);
    expect(userData).toContain(`\nUAT_SSM_PREFIX=${prefix}\n`);
    expect(userData).toContain(`\nSECRET_ID=${config.runner.tokenSecretName}\n`);
    expect(userData).toContain(`\nARTIFACTORY_SECRET_ID=${config.artifactory.tokenSecretName}\n`);
  });

  test('jobs run on exactly the labels the runners register with', () => {
    const runsOn = matches(workflow, /runs-on: \[([^\]]+)\]/g);
    expect(runsOn.length).toBeGreaterThan(0);
    for (const labels of runsOn) {
      expect(labels.split(',').map(l => l.trim()).sort()).toEqual([...config.runner.labels].sort());
    }
    // self-hosted is implied by registering at all; the rest are passed to config.sh.
    expect(userData).toContain(`\nLABELS=${config.runner.labels.filter(l => l !== 'self-hosted').join(',')}\n`);
  });

  test('the tools the scripts call are installed', () => {
    expect(userData).toMatch(/dnf install[^\n]*\bjq\b/);
    expect(userData).toMatch(/dnf install[^\n]*\bpython3\.11\b/);
    expect(userData).toContain('Environment=UAT_PYTHON=/usr/bin/python3.11');
  });
});

describe('the runner role can do what the scripts and harness do', () => {
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
    const buckets = resources(tf, 'aws_s3_bucket');
    const puts = s.filter(st => asList(st.actions).some((a: string) => a.startsWith('s3:PutObject')));
    const res = JSON.stringify(puts);
    for (const role of ['evidence', 'builds']) {
      const name = Object.keys(buckets).find(n => buckets[n].bucket_prefix.includes(`-${role}-`))!;
      expect(res).toContain(ref('aws_s3_bucket', name, 'arn'));
    }
  });

  test('it can use the key both buckets are encrypted with', () => {
    const [key] = only(tf, 'aws_kms_key');
    for (const a of ['kms:Decrypt', 'kms:GenerateDataKey']) expect(allows(s, a, ref('aws_kms_key', key, 'arn'))).toBe(true);
  });

  test('the role cannot write discovery parameters it only reads', () => {
    const writes = s.filter(st => asList(st.actions).includes('ssm:PutParameter'));
    expect(JSON.stringify(writes)).not.toContain(`${prefix}/*`);
  });
});

test('the configured Bedrock model is a profile the runner may invoke', () => {
  expect(config.bedrockModelId).toMatch(/^(global|au|us|eu|apac)\.anthropic\.|^anthropic\./);
});
