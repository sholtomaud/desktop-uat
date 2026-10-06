/**
 * Synthesizes the stack the way `make tf-synth` does, but to JSON: the same
 * configuration as the committed HCL, in a shape a test can index into.
 */
import { Testing } from 'cdktn';
import { UatConfig, uatConfig } from '../lib/config';
import { UatStack } from '../lib/uat-stack';

export const config = uatConfig();

export interface Tf {
  resource: Record<string, Record<string, any>>;
  data: Record<string, Record<string, any>>;
  output: Record<string, { value: string }>;
  locals: Record<string, any>;
  provider: Record<string, any[]>;
  terraform: any;
}

export function synth(c: UatConfig = config) {
  const stack = new UatStack(Testing.app(), 'test', { config: c });
  return { stack, tf: JSON.parse(Testing.synth(stack)) as Tf };
}

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

/** The name a `${type.name.attr}` reference points at. */
export function refName(expr: string, type: string): string {
  const m = expr.match(new RegExp(`^\\$\\{${type.replace(/\./g, '\\.')}\\.([a-z0-9_]+)\\.[a-z_]+\\}$`));
  if (!m) throw new Error(`${expr} is not a reference to a ${type}`);
  return m[1];
}

export const asList = <T>(x: T | T[]): T[] => (Array.isArray(x) ? x : [x]);

/** Every policy statement attached inline to a role, from its aws_iam_policy_document. */
export function roleStatements(tf: Tf, roleName: string): any[] {
  return Object.values(resources(tf, 'aws_iam_role_policy'))
    .filter((p: any) => p.role === ref('aws_iam_role', roleName, 'name'))
    .flatMap((p: any) => dataSources(tf, 'aws_iam_policy_document')[refName(p.policy, 'data.aws_iam_policy_document')].statement);
}

/** Does any Allow statement grant `action` on a resource that contains `resource`? */
export function allows(statements: any[], action: string, resource: string): boolean {
  return statements.some(s => (s.effect ?? 'Allow') === 'Allow'
    && asList(s.actions).some((a: string) => a === action || (a.endsWith('*') && action.startsWith(a.slice(0, -1))))
    && asList(s.resources).some((r: string) => r.includes(resource)));
}
