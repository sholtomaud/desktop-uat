/**
 * The committed artifact is HCL, so what matters is the HCL. These tests pin
 * what a Terraform reader sees: readable names, valid syntax where cdktn's
 * renderer gets it wrong, a local backend for now, and the whole output as a
 * snapshot.
 */
import { heredocSafe, unquoteReferenceLists } from '../lib/hcl';
import { hclOf, synth } from './support';

const hcl = hclOf();

test('the whole configuration, as HCL', () => {
  expect(hcl).toMatchSnapshot();
});

test('resources are named by their place in the tree, without hash suffixes', () => {
  const { tf } = synth();
  const names = [...Object.values(tf.resource), ...Object.values(tf.data)].flatMap(byName => Object.keys(byName));
  for (const n of names) expect(n).toMatch(/^((storage|desktop|run|operator)_[a-z0-9_]+|partition)$/);
  expect(Object.keys(tf.variable)).toContain('vpc_id');
});

test('no backslash but the quote escapes cdktn writes: it escapes nothing else, so \\U would be read as an escape', () => {
  expect(hcl.replace(/\\"/g, '')).not.toContain('\\');
});

test('state is local and relative, until the Artifactory backend exists', () => {
  expect(hcl).toMatch(/backend "local" \{\s*path = "terraform\.tfstate"\s*\}/);
});

test('only the aws provider, pinned', () => {
  const { tf } = synth();
  expect(Object.keys(tf.terraform.required_providers)).toEqual(['aws']);
  expect(tf.terraform.required_providers.aws).toEqual({ source: 'hashicorp/aws', version: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
});

test('depends_on names references bare, as Terraform 0.12+ expects', () => {
  expect(hcl).toMatch(/depends_on = \[\s*aws_s3_bucket_public_access_block\.storage_public_access,/);
  expect(hcl).not.toMatch(/(depends_on|ignore_changes) = \[\s*"/);
});

test('the reference-list fix leaves every other quoted list alone', () => {
  const src = 'actions = [\n"s3:*",\n]\ndepends_on = [\n"aws_vpc.a",\n"aws_vpc.b",\n]\nlifecycle {\nignore_changes = [\n"value",\n]\n}\nsubnet_ids = [\n"x",\n]';
  expect(unquoteReferenceLists(src)).toBe(
    'actions = [\n"s3:*",\n]\ndepends_on = [\naws_vpc.a,\naws_vpc.b,\n]\nlifecycle {\nignore_changes = [\nvalue,\n]\n}\nsubnet_ids = [\n"x",\n]');
});

describe('multi-line strings are heredocs, written verbatim', () => {
  test('the documents are readable JSON in the HCL, exactly as synthesized', () => {
    const { tf } = synth();
    for (const doc of Object.values(tf.resource.aws_ssm_document) as any[]) {
      // A heredoc's value runs up to and including the newline before its closing EOF.
      expect(hcl).toContain(`content = <<EOF\n${doc.content}\nEOF`);
    }
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
});
