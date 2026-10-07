/**
 * cdktn 0.24 writes `depends_on` and `ignore_changes` entries as quoted strings,
 * a Terraform 0.11 form that OpenTofu and Terraform warn is deprecated and will
 * remove. These two lists only ever hold references, so unquote them.
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
