/**
 * Everything this app does to cdktn's HCL text: two fixes for faults in cdktn
 * 0.24's renderer, and the split into a root module's usual files.
 */

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

/**
 * Splits one formatted (tofu fmt) HCL file into the conventional layout of a
 * root module: versions.tf, providers.tf, variables.tf, locals.tf, outputs.tf,
 * one <component>.tf per construct below the stack, which names its resources
 * <component>_... (see UatStack.allocateLogicalId), and main.tf for anything
 * declared on the stack itself.
 *
 * Formatted HCL opens each top-level block at column 0 and closes it with a "}"
 * at column 0. A heredoc's body is the one place that could break that rule, so
 * it is skipped over.
 */
export function splitHcl(formatted: string): Record<string, string> {
  const files: Record<string, string[]> = {};
  const lines = formatted.split('\n');
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    if (header.trim() === '') { i++; continue; }
    if (!/\{$/.test(header) || /^\s/.test(header)) throw new Error(`HCL outside a block at line ${i + 1}: ${header}`);

    const start = i;
    let heredoc: string | undefined;
    for (i++; ; i++) {
      if (i >= lines.length) throw new Error(`unterminated block starting at line ${start + 1}: ${header}`);
      const line = lines[i];
      if (heredoc) {
        if (line.trim() === heredoc) heredoc = undefined;
        continue;
      }
      const opens = line.match(/<<-?([A-Za-z_]+)$/);
      if (opens) { heredoc = opens[1]; continue; }
      if (line === '}') break;
    }
    i++;
    (files[fileFor(header)] ??= []).push(lines.slice(start, i).join('\n') + '\n');
  }
  return Object.fromEntries(Object.entries(files).map(([f, blocks]) => [f, blocks.join('\n')]));
}

function fileFor(header: string): string {
  const kind = header.split(/[\s{]/)[0];
  switch (kind) {
    case 'terraform': return 'versions.tf';
    case 'provider': return 'providers.tf';
    case 'variable': return 'variables.tf';
    case 'locals': return 'locals.tf';
    case 'output': return 'outputs.tf';
    case 'resource':
    case 'data': {
      const name = header.match(/^\w+ "[^"]+" "([a-z0-9]+)_/);
      return name ? `${name[1]}.tf` : 'main.tf';
    }
    default: throw new Error(`unexpected top-level block: ${header}`);
  }
}
