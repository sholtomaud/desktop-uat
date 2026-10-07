/**
 * The seams between this configuration and the Windows scripts baked into the
 * image (image/ec2/). Terraform never sees the scripts and the scripts never see
 * Terraform: they meet at the config parameter, the documents' parameters, the
 * script paths, and the instance role. Change both sides in one PR (AGENTS.md §6).
 */
import { allows, only, read, ref, resources, statementsOf, synth } from './support';

const { tf } = synth();
const script = (name: string) => read(`image/ec2/${name}`);
const docs = Object.values(resources(tf, 'aws_ssm_document')) as any[];
const runDoc = JSON.parse(docs.find(d => /-run$/.test(d.name.replace('${var.environment}', 'env'))).content);

/** The names in a PowerShell script's top-level param( ... ) block. */
function paramsOf(src: string): string[] {
  const block = src.match(/^param\s*\(([\s\S]*?)^\)/m);
  if (!block) throw new Error('no param() block');
  return [...block[1].matchAll(/\$([A-Za-z0-9]+)\s*(?:=|,|$)/gm)].map(m => m[1]);
}

const SCRIPTS = ['UatEc2.psm1', 'Uat-Boot.ps1', 'Uat-Run.ps1', 'Uat-Session.ps1', 'Uat-Leave.ps1'];

test('Uat-Run.ps1 takes exactly the run document\'s parameters', () => {
  expect(paramsOf(script('Uat-Run.ps1')).sort()).toEqual(Object.keys(runDoc.parameters).sort());
});

test('Uat-Boot.ps1 takes the config parameter\'s name, which user data passes', () => {
  expect(paramsOf(script('Uat-Boot.ps1'))).toEqual(['ConfigParameter']);
  const [, lt] = only(tf, 'aws_launch_template');
  expect(lt.user_data).toContain("-ConfigParameter '${aws_ssm_parameter.");
});

test('every config key a script reads is one Terraform writes', () => {
  const p = (Object.values(resources(tf, 'aws_ssm_parameter')) as any[]).find(x => x.name.endsWith('/ec2-config'));
  const written = [...p.value.matchAll(/"([A-Za-z]+)" = /g)].map((m: RegExpMatchArray) => m[1]);
  const readKeys = new Set(SCRIPTS.flatMap(n => [...script(n).matchAll(/\$config\.([A-Za-z]+)/g)].map(m => m[1])));
  expect(readKeys.size).toBeGreaterThan(0);
  for (const k of readKeys) expect(written).toContain(k);
});

test('the bake installs every script where the documents and user data call it', () => {
  const bake = script('Build-UatEc2Image.ps1');
  expect(bake).toMatch(/\$UatRoot\s*=\s*'C:\\Uat'/);
  for (const n of SCRIPTS) expect(bake).toContain(n);
});

test('the boot script reads its expiry from the instance tag the launch template lets it see', () => {
  expect(script('UatEc2.psm1')).toContain("'desktop-uat-expires-at'");
  expect(script('UatEc2.psm1')).toContain('/latest/meta-data/tags/instance/');
  const [, lt] = only(tf, 'aws_launch_template');
  expect(lt.metadata_options.instance_metadata_tags).toBe('enabled');
});

describe('every AWS call the scripts make, the instance role allows', () => {
  const [role] = Object.entries(resources(tf, 'aws_iam_role')).find(([n]) => n.startsWith('desktop_'))!;
  const s = statementsOf(tf, (Object.values(resources(tf, 'aws_iam_role_policy')) as any[])
    .find(p => p.role === ref('aws_iam_role', role, 'name')).policy);
  const [bucket] = only(tf, 'aws_s3_bucket');
  const [config] = Object.entries(resources(tf, 'aws_ssm_parameter')).find(([, x]: [string, any]) => x.name.endsWith('/ec2-config'))!;
  // AWS Tools for PowerShell cmdlet -> the IAM action and resource it needs.
  const needs: Record<string, [string, string]> = {
    'Get-SSMParameter': ['ssm:GetParameter', ref('aws_ssm_parameter', config, 'arn')],
    'Get-SECSecretValue': ['secretsmanager:GetSecretValue', ':secret:'],
    'Write-S3Object': ['s3:PutObject', `${ref('aws_s3_bucket', bucket, 'arn')}/runs/*`],
  };
  const called = new Set(SCRIPTS.flatMap(n =>
    [...script(n).matchAll(/\b((?:Get|Set|New|Write|Read|Remove|Copy|Send)-(?:SSM|SEC|S3|EC2|IAM|STS)[A-Za-z]+)\b/g)].map(m => m[1])));

  test('the scripts call AWS only through cmdlets this test knows', () => {
    expect([...called].sort()).toEqual(Object.keys(needs).sort());
  });

  test.each(Object.entries(needs))('%s', (_cmdlet, [action, resource]) => {
    expect(allows(s, action, resource)).toBe(true);
  });
});
