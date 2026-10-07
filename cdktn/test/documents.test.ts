/**
 * The SSM documents ec2-uat.sh sends: `run` (a scripted UAT run in the desktop
 * session) and `leave` (leave the domain before termination). SSM substitutes
 * parameters into the command text, so each parameter is pinned by a pattern
 * that cannot close the single-quoted PowerShell string it lands in.
 */
import { only, resources, synth, v } from './support';

const { tf } = synth();
const docs = resources(tf, 'aws_ssm_document');
const named = (suffix: string) => Object.values(docs).find((d: any) => d.name === `desktop-uat-${v('environment')}-${suffix}`) as any;
const content = (suffix: string) => JSON.parse(named(suffix).content);

test.each(['run', 'leave'])('%s is a JSON command document, run as PowerShell', suffix => {
  expect(named(suffix)).toMatchObject({ document_type: 'Command', document_format: 'JSON' });
  const c = content(suffix);
  expect(c.schemaVersion).toBe('2.2');
  expect(c.mainSteps).toEqual([expect.objectContaining({ action: 'aws:runPowerShellScript' })]);
});

describe('run', () => {
  const c = content('run');
  const params = c.parameters as Record<string, { type: string; allowedPattern: string; default?: string }>;
  const command: string[] = c.mainSteps[0].inputs.runCommand;

  test('takes the run\'s inputs, each pinned by a pattern', () => {
    expect(Object.keys(params).sort()).toEqual(
      ['BuildSha256', 'BuildUrl', 'GitRef', 'GitSha', 'RunId', 'ScenariosUrl', 'StateRoot', 'Tags']);
    for (const p of Object.values(params)) {
      expect(p.type).toBe('String');
      expect(p.allowedPattern).toMatch(/^\^.*\$$/);
    }
  });

  test('passes each one to Uat-Run.ps1, single-quoted', () => {
    expect(command).toHaveLength(1);
    expect(command[0]).toMatch(/^& 'C:\/Uat\/Uat-Run\.ps1' /);
    for (const name of Object.keys(params)) expect(command[0]).toContain(`-${name} '{{ ${name} }}'`);
  });

  test('gives the run as long as a run may take, and reports a failed run as failed', () => {
    expect(Number(c.mainSteps[0].inputs.timeoutSeconds)).toBeGreaterThanOrEqual(3600);
    expect(command[0]).toMatch(/; exit \$LASTEXITCODE$/);
  });

  const presigned = 'https://desktop-uat-uat-20261007.s3.ap-southeast-2.amazonaws.com/staging/r1/build.zip'
    + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261007%2Fap-southeast-2%2Fs3%2Faws4_request'
    + '&X-Amz-Date=20261007T010203Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123';

  test.each([
    ['RunId', '12345-1'],
    ['BuildUrl', presigned],
    ['ScenariosUrl', presigned],
    ['BuildSha256', 'a'.repeat(64)],
    ['Tags', 'smoke,login'],
    ['Tags', ''],
    ['StateRoot', '%APPDATA%/UatDemo'],
    ['GitRef', 'refs/heads/feat/x'],
    ['GitSha', 'f'.repeat(40)],
    ['GitSha', ''],
  ])('%s accepts %p', (name, value) => {
    expect(new RegExp(params[name].allowedPattern).test(value)).toBe(true);
  });

  test.each(Object.keys(content('run').parameters))('%s refuses a quote, so nothing can escape into PowerShell', name => {
    for (const evil of ["x' ; Remove-Item C:/ -Recurse ; '", "x'", 'x"', 'x`n', 'x\ny']) {
      expect(new RegExp(params[name].allowedPattern).test(evil)).toBe(false);
    }
  });

  test('a URL must be https', () => {
    expect(new RegExp(params.BuildUrl.allowedPattern).test(presigned.replace('https', 'http'))).toBe(false);
  });
});

test('leave takes no input and runs Uat-Leave.ps1', () => {
  const c = content('leave');
  expect(c.parameters ?? {}).toEqual({});
  expect(c.mainSteps[0].inputs.runCommand).toEqual(["& 'C:/Uat/Uat-Leave.ps1'; exit $LASTEXITCODE"]);
});

test('document outputs name both', () => {
  expect(tf.output.run_document.value).toMatch(/aws_ssm_document\.run_run\.name/);
  expect(tf.output.leave_document.value).toMatch(/aws_ssm_document\.run_leave\.name/);
  void only;
});
