import { AppstreamStack } from '@cdktn/provider-awscc/lib/appstream-stack';
import { TerraformLocal } from 'cdktn';
import { Construct } from 'constructs';

/**
 * cdktn 0.24 renders every nested object of a resource as an HCL block. That is
 * right for the aws provider, whose nested objects are blocks, and wrong for
 * awscc, which has none: `agent_access_config { ... }` fails validation, and
 * `agent_access_config = { ... }` is what it takes. (JSON synthesis has no such
 * distinction, so only HCL output is affected.)
 *
 * This turns each block descriptor into a plain value of type "any", which the
 * renderer writes as an attribute expression. `make tf-validate` checks the
 * result against the real provider schema, so a cdktn release that fixes this
 * or breaks it is caught.
 */
export function attributesOnly(attrs: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(attrs).map(([name, d]) =>
    [name, d?.isBlock ? { value: plain(d.value), type: 'any' } : d]));
}

const isDescriptor = (v: any) =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && 'value' in v && ('isBlock' in v || 'type' in v);

/** Strips the renderer's `{ value, isBlock, type, ... }` wrappers down to the values. */
function plain(v: any): any {
  if (isDescriptor(v)) return plain(v.value);
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]).filter(([, x]) => x !== undefined));
  }
  return v;
}

/** awscc_appstream_stack, rendered with awscc's attribute syntax. */
export class AwsccAppstreamStack extends AppstreamStack {
  protected synthesizeHclAttributes(): { [name: string]: any } {
    return attributesOnly(super.synthesizeHclAttributes());
  }
}

/**
 * cdktn 0.24 also writes `depends_on` and `ignore_changes` entries as quoted
 * strings, a Terraform 0.11 form that OpenTofu and Terraform warn is deprecated
 * and will remove. These two lists only ever hold references, so unquote them.
 */
export function unquoteReferenceLists(hcl: string): string {
  return hcl.replace(/((?:depends_on|ignore_changes) = \[\n)((?:\s*"[^"\n]*",\n)*)/g,
    (_, head: string, items: string) => head + items.replace(/"([A-Za-z0-9_.]+)"/g, '$1'));
}

/**
 * cdktn writes a multi-line string as `<<EOF ... EOF`, verbatim: a line reading
 * EOF would end it early, and `${` or `%{` would turn into Terraform template
 * syntax. Either way the deployed text would differ from the source, so such a
 * string is refused here, at synth, instead.
 */
export function heredocSafe(s: string): string {
  const problem = /^EOF$/m.test(s) ? 'a line reading EOF'
    : s.includes('${') ? '"${"'
    : s.includes('%{') ? '"%{"'
    : undefined;
  if (problem) throw new Error(`Cannot write this string as an HCL heredoc: it contains ${problem}`);
  return s;
}

/**
 * cdktn 0.24 writes a multi-line local as a quoted string with raw newlines in
 * it, which is not HCL. This rewrites one local, given its value, as a heredoc.
 * If cdktn has not written it in exactly that form, it fails rather than guess.
 */
export function heredocLocal(hcl: string, name: string, value: string): string {
  heredocSafe(value);
  if (!value.endsWith('\n')) throw new Error(`local "${name}": a heredoc ends in a newline, so its value must too`);
  const quoted = `${name} = "${value.replace(/(?<!\\)"/g, '\\"')}"`;
  if (!hcl.includes(quoted)) throw new Error(`local "${name}" is not in the HCL in the form cdktn writes`);
  return hcl.replace(quoted, () => `${name} = <<EOF\n${value}EOF`);
}

/**
 * A multi-line string local that the stack writes as a heredoc (see
 * heredocLocal). It keeps the text, which the local itself only holds as a token.
 */
export class HeredocLocal extends TerraformLocal {
  constructor(scope: Construct, id: string, public readonly text: string) {
    super(scope, id, heredocSafe(text));
  }
}
