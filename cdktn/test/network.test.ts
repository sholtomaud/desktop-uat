/**
 * The three subnet tiers of infra/lib/network-stack.ts, as plain Terraform:
 * public (NAT only), runners (egress through NAT), fleet (no route out at all,
 * only the S3 gateway endpoint).
 */
import { asList, config, only, ref, resources, synth } from './support';

const { tf } = synth();
const subnets = resources(tf, 'aws_subnet');
const tables = resources(tf, 'aws_route_table');
const routes = Object.values(resources(tf, 'aws_route')) as any[];
const tier = (t: string) => Object.keys(subnets).filter(n => subnets[n].tags.Tier === t);
const tablesOf = (t: string) => Object.keys(tables).filter(n => tables[n].tags.Tier === t);
const [vpcName, vpc] = only(tf, 'aws_vpc');

test('the VPC uses the configured CIDR and resolves private endpoint DNS', () => {
  expect(vpc).toMatchObject({ cidr_block: config.vpcCidr, enable_dns_hostnames: true, enable_dns_support: true });
});

test.each([['public', 26], ['runners', 24], ['fleet', 22]])('%s: one /%i per AZ', (t, mask) => {
  const names = tier(t as string);
  expect(names.map(n => subnets[n].availability_zone)).toEqual(['ap-southeast-2a', 'ap-southeast-2b']);
  for (const n of names) {
    expect(subnets[n].cidr_block).toMatch(new RegExp(`/${mask}$`));
    expect(subnets[n].vpc_id).toBe(ref('aws_vpc', vpcName, 'id'));
  }
});

test('no subnet hands out public IPs; NAT gateways have their own', () => {
  for (const s of Object.values(subnets) as any[]) expect(s.map_public_ip_on_launch ?? false).toBe(false);
});

test('every subnet has its own tier route table', () => {
  for (const assoc of Object.values(resources(tf, 'aws_route_table_association')) as any[]) {
    const subnet = Object.keys(subnets).find(n => assoc.subnet_id === ref('aws_subnet', n, 'id'))!;
    const table = Object.keys(tables).find(n => assoc.route_table_id === ref('aws_route_table', n, 'id'))!;
    expect(tables[table].tags.Tier).toBe(subnets[subnet].tags.Tier);
  }
  expect(Object.keys(resources(tf, 'aws_route_table_association'))).toHaveLength(Object.keys(subnets).length);
});

test('only public tables route to the internet gateway', () => {
  const [igw] = only(tf, 'aws_internet_gateway');
  const viaIgw = routes.filter(r => r.gateway_id === ref('aws_internet_gateway', igw, 'id'));
  expect(viaIgw.map(r => r.route_table_id).sort())
    .toEqual(tablesOf('public').map(n => ref('aws_route_table', n, 'id')).sort());
});

test('runner tables default-route through a NAT gateway; one NAT per configured gateway', () => {
  const nats = Object.keys(resources(tf, 'aws_nat_gateway'));
  expect(nats).toHaveLength(config.natGateways);
  for (const t of tablesOf('runners')) {
    const r = routes.find(x => x.route_table_id === ref('aws_route_table', t, 'id'));
    expect(r.destination_cidr_block).toBe('0.0.0.0/0');
    expect(nats.map(n => ref('aws_nat_gateway', n, 'id'))).toContain(r.nat_gateway_id);
  }
});

test('fleet tables have no routes at all: the desktops are isolated', () => {
  const fleetTables = tablesOf('fleet').map(n => ref('aws_route_table', n, 'id'));
  expect(fleetTables).toHaveLength(config.maxAzs);
  expect(routes.filter(r => fleetTables.includes(r.route_table_id))).toEqual([]);
  for (const t of tablesOf('fleet')) expect(tables[t].route ?? []).toEqual([]);
});

test('the S3 gateway endpoint reaches every tier, the fleet included', () => {
  const s3 = (Object.values(resources(tf, 'aws_vpc_endpoint')) as any[])
    .find(e => e.service_name === `com.amazonaws.${config.region}.s3`);
  expect(s3.vpc_endpoint_type).toBe('Gateway');
  expect([...s3.route_table_ids].sort()).toEqual(Object.keys(tables).map(n => ref('aws_route_table', n, 'id')).sort());
});

describe('interface endpoints', () => {
  const eps = (Object.values(resources(tf, 'aws_vpc_endpoint')) as any[]).filter(e => e.vpc_endpoint_type === 'Interface');

  test('one per configured service, private DNS on', () => {
    expect(eps.map(e => e.service_name).sort())
      .toEqual(config.interfaceEndpoints.map(s => `com.amazonaws.${config.region}.${s}`).sort());
    for (const e of eps) expect(e.private_dns_enabled).toBe(true);
  });

  test('in the runner tier only; the fleet tier deliberately gets none', () => {
    const runnerIds = tier('runners').map(n => ref('aws_subnet', n, 'id')).sort();
    for (const e of eps) expect([...e.subnet_ids].sort()).toEqual(runnerIds);
  });

  test('behind a group that admits HTTPS from the VPC and nothing else', () => {
    const groups = new Set(eps.flatMap(e => e.security_group_ids));
    expect(groups.size).toBe(1);
    const [sg] = [...groups];
    const ingress = (Object.values(resources(tf, 'aws_vpc_security_group_ingress_rule')) as any[])
      .filter(r => r.security_group_id === sg);
    expect(ingress).toEqual([expect.objectContaining({ cidr_ipv4: config.vpcCidr, from_port: 443, to_port: 443, ip_protocol: 'tcp' })]);
    const egress = (Object.values(resources(tf, 'aws_vpc_security_group_egress_rule')) as any[])
      .filter(r => r.security_group_id === sg);
    expect(egress).toEqual([]);
  });
});

test('the default security group is taken over and left with no rules', () => {
  const [, sg] = only(tf, 'aws_default_security_group');
  expect(sg.vpc_id).toBe(ref('aws_vpc', vpcName, 'id'));
  expect(asList(sg.ingress ?? [])).toEqual([]);
  expect(asList(sg.egress ?? [])).toEqual([]);
});

test('all traffic is flow-logged to a log group kept for a year', () => {
  const [, log] = only(tf, 'aws_flow_log');
  expect(log).toMatchObject({ traffic_type: 'ALL', vpc_id: ref('aws_vpc', vpcName, 'id'), log_destination_type: 'cloud-watch-logs' });
  const groups = resources(tf, 'aws_cloudwatch_log_group');
  const dest = Object.keys(groups).find(n => log.log_destination === ref('aws_cloudwatch_log_group', n, 'arn'))!;
  expect(groups[dest].retention_in_days).toBe(365);
});
