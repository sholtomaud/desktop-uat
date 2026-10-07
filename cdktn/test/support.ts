/**
 * Synthesizes the stack the way `make cdktn-synth` does, but to JSON: the same
 * configuration as the committed HCL, in a shape a test can index into.
 */
import { Testing } from 'cdktn';
import * as fs from 'fs';
import * as path from 'path';
import { UatStack } from '../lib/uat-stack';

export interface Tf {
  resource: Record<string, Record<string, any>>;
  data: Record<string, Record<string, any>>;
  output: Record<string, { value: string; description?: string }>;
  variable: Record<string, any>;
  provider: Record<string, any[]>;
  terraform: any;
}

export function synth() {
  const stack = new UatStack(Testing.app(), 'test');
  return { stack, tf: JSON.parse(Testing.synth(stack)) as Tf };
}

export const hclOf = () => Testing.synthHcl(new UatStack(Testing.app(), 'test')) as string;

/** `{ "<name>": {...} }` of one resource type, or `{}`. */
export const resources = (tf: Tf, type: string): Record<string, any> => tf.resource[type] ?? {};
export const dataSources = (tf: Tf, type: string): Record<string, any> => tf.data?.[type] ?? {};

/** The only resource of a type; fails if there are none or several. */
export function only(tf: Tf, type: string): [string, any] {
  const all = Object.entries(resources(tf, type));
  expect(all.map(([name]) => name)).toHaveLength(1);
  return all[0];
}

/** `${type.name.attr}`: how a reference to another resource reads in the output. */
export const ref = (type: string, name: string, attr: string) => `\${${type}.${name}.${attr}}`;
export const v = (name: string) => `\${var.${name}}`;

/** The name a `${data.aws_iam_policy_document.X.json}` reference points at. */
export function docName(expr: string): string {
  const m = expr.match(/^\$\{data\.aws_iam_policy_document\.([a-z0-9_]+)\.json\}$/);
  if (!m) throw new Error(`${expr} is not a policy document reference`);
  return m[1];
}

export const statementsOf = (tf: Tf, expr: string): any[] =>
  dataSources(tf, 'aws_iam_policy_document')[docName(expr)].statement;

export const asList = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** Does any Allow statement grant `action` on a resource containing `resource`? */
export function allows(statements: any[], action: string, resource: string): boolean {
  return statements.some(s => (s.effect ?? 'Allow') === 'Allow'
    && asList(s.actions).some((a: string) => a === action || (a.endsWith('*') && action.startsWith(a.slice(0, -1))))
    && asList(s.resources).some((r: string) => r.includes(resource)));
}

export const ROOT = path.resolve(__dirname, '..', '..');
export const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
