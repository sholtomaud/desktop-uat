/**
 * cdktn/ deploys what infra/ deploys, from the same settings: the "uat" context
 * in infra/cdk.json, validated by infra's own loader, and the AZ lookup committed
 * in infra/cdk.context.json. Changing a setting changes both, so they cannot drift.
 */
import { RootConstruct } from 'constructs';
import { UatConfig, loadConfig, ssmPrefix } from '../../infra/lib/config';
import * as cdkJson from '../../infra/cdk.json';
import * as cdkContext from '../../infra/cdk.context.json';

export type { UatConfig };
export { ssmPrefix };

export function uatConfig(raw: unknown = cdkJson.context.uat): UatConfig {
  const root = new RootConstruct();
  root.node.setContext('uat', raw);
  return loadConfig(root.node);
}

/** The first maxAzs AZs of the region, as the CDK picked them, offline. */
export function availabilityZones(c: UatConfig): string[] {
  const key = `availability-zones:account=${c.account}:region=${c.region}`;
  const azs = (cdkContext as Record<string, string[] | undefined>)[key];
  if (!azs) throw new Error(`No "${key}" in infra/cdk.context.json: commit the region's AZs there (see AGENTS.md §7)`);
  return azs.slice(0, c.maxAzs);
}

export interface SubnetGroup { name: string; mask: number }

/**
 * Lays subnets out the way the CDK's Vpc does: group by group in order, one block
 * per AZ, each at the next address aligned to its size.
 */
export function allocateSubnets(vpcCidr: string, groups: SubnetGroup[], azCount: number): Record<string, string[]> {
  const [base, bits] = vpcCidr.split('/');
  const start = toInt(base);
  const end = start + 2 ** (32 - Number(bits));
  let next = start;
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    const size = 2 ** (32 - g.mask);
    out[g.name] = [];
    for (let i = 0; i < azCount; i++) {
      next = Math.ceil(next / size) * size;
      if (next + size > end) throw new Error(`Subnet layout does not fit in ${vpcCidr}`);
      out[g.name].push(`${toIp(next)}/${g.mask}`);
      next += size;
    }
  }
  return out;
}

const toInt = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0);
const toIp = (n: number) => [24, 16, 8, 0].map(s => Math.floor(n / 2 ** s) % 256).join('.');
