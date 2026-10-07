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
