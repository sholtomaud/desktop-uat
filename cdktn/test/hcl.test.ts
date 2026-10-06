/**
 * The committed artifact is HCL, so what matters is the HCL. These tests pin
 * what a Terraform reader sees: readable names, the right syntax for each
 * provider, a backend that is local for now, and the whole output as a snapshot.
 */
import { Testing } from 'cdktn';
import { heredocLocal, heredocSafe, unquoteReferenceLists } from '../lib/hcl';
import { UatStack } from '../lib/uat-stack';
import { config, synth } from './support';

const hcl: string = Testing.synthHcl(new UatStack(Testing.app(), 'test', { config }));

test('the whole configuration, as HCL', () => {
  expect(hcl).toMatchSnapshot();
});

test('resources are named by their place in the tree, without hash suffixes', () => {
  const { tf } = synth();
  const names = Object.values(tf.resource).flatMap(byName => Object.keys(byName));
  expect(names).toContain('network_vpc');
  expect(names).toContain('desktop_fleet');
  expect(names).toContain('runners_asg');
  for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  for (const n of names) expect(n).not.toMatch(/_[0-9A-F]{8}$/);
});

test('awscc nested objects are attributes (`x = {`), not blocks: awscc has no blocks', () => {
  expect(hcl).toMatch(/agent_access_config = \{/);
  expect(hcl).not.toMatch(/agent_access_config \{/);
  expect(hcl).toMatch(/settings = \[/);
});

test('aws nested blocks stay blocks', () => {
  expect(hcl).toMatch(/metadata_options \{/);
  expect(hcl).toMatch(/vpc_config \{/);
});

test('state is local and relative, until the Artifactory backend exists', () => {
  expect(hcl).toMatch(/backend "local" \{\s*path = "terraform\.tfstate"\s*\}/);
});

test('providers are pinned, refuse any account but the configured one, and tag everything', () => {
  const { tf } = synth();
  expect(tf.terraform.required_providers).toMatchObject({
    aws: { source: 'hashicorp/aws', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
    awscc: { source: 'hashicorp/awscc', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
    archive: { source: 'hashicorp/archive', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
  });
  expect(tf.provider.aws[0]).toMatchObject({
    region: config.region,
    allowed_account_ids: [config.account],
    default_tags: [{ tags: { Project: 'desktop-uat', Environment: config.envName } }],
  });
  expect(tf.provider.awscc[0]).toMatchObject({ region: config.region });
});

test('depends_on and ignore_changes name references bare, as Terraform 0.12+ expects', () => {
  expect(hcl).toMatch(/depends_on = \[\s*aws_internet_gateway\.network_igw,/);
  expect(hcl).toMatch(/ignore_changes = \[\s*value,/);
  expect(hcl).not.toMatch(/(depends_on|ignore_changes) = \[\s*"/);
});

test('the reference-list fix leaves every other quoted list alone', () => {
  const src = 'actions = [\n"s3:*",\n]\ndepends_on = [\n"aws_vpc.a",\n"aws_vpc.b",\n]\nlifecycle {\nignore_changes = [\n"value",\n]\n}\nsubnet_ids = [\n"x",\n]';
  expect(unquoteReferenceLists(src)).toBe(
    'actions = [\n"s3:*",\n]\ndepends_on = [\naws_vpc.a,\naws_vpc.b,\n]\nlifecycle {\nignore_changes = [\nvalue,\n]\n}\nsubnet_ids = [\n"x",\n]');
});

describe('multi-line strings are heredocs, written verbatim', () => {
  // A heredoc's value runs up to and including the newline before its closing EOF.
  const heredoc = (name: string) => hcl.match(new RegExp(`${name}\\s*= <<EOF\\n([\\s\\S]*?\\n)EOF\\n`))![1];

  test('the runner boot script is readable in the HCL, and is exactly the script', () => {
    const { tf } = synth();
    expect(hcl).toMatch(/user_data\s*= "\$\{base64encode\(local\.runners_user_data\)\}"/);
    expect(heredoc('runners_user_data')).toBe(tf.locals.runners_user_data);
  });

  test('the janitor code in the HCL is the code, ending in one newline', () => {
    const { tf } = synth();
    const [archive] = Object.values(tf.data.archive_file) as any[];
    expect(heredoc('content')).toBe(`${archive.source[0].content}\n`);
  });

  test.each([
    ['a line reading EOF, which would end the heredoc', 'a\nEOF\nb\n'],
    ['${, which Terraform would interpolate', 'a\necho ${HOME}\n'],
    ['%{, which Terraform would treat as a directive', 'a\n%{ if x }\n'],
  ])('a string containing %s is refused at synth', (_why, s) => {
    expect(() => heredocSafe(s)).toThrow(/heredoc/);
  });

  test('anything else passes through unchanged', () => {
    const s = 'echo "$HOME" $(date +%s) \\\n  --next\n';
    expect(heredocSafe(s)).toBe(s);
  });

  test('a multi-line local is rewritten from the quoted form cdktn writes to a heredoc', () => {
    const value = 'echo "hi"\nexit 0\n';
    const cdktnForm = 'locals {\n    x = "echo \\"hi\\"\nexit 0\n"\n}';
    expect(heredocLocal(cdktnForm, 'x', value)).toBe('locals {\n    x = <<EOF\necho "hi"\nexit 0\nEOF\n}');
  });

  test('a local that is not where cdktn would write it fails loudly', () => {
    expect(() => heredocLocal('locals {\n}', 'x', 'a\nb\n')).toThrow(/local "x"/);
  });

  test('a local not ending in a newline cannot be a heredoc, and is refused', () => {
    expect(() => heredocLocal('x = "a\nb"', 'x', 'a\nb')).toThrow(/newline/);
  });
});
