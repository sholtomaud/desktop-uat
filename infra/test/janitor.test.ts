/**
 * The fleet janitor: the cost safety net that stops a fleet a cancelled job left
 * running. Its code ships inline in the template, so the test takes it from
 * there — exactly what Lambda would run — and executes it against a fake AWS SDK.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { UatConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { UatDesktopStack } from '../lib/uat-desktop-stack';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const config: UatConfig = require('../cdk.json').context.uat;

const app = new cdk.App();
const env = { account: '111122223333', region: 'ap-southeast-2' };
const net = new NetworkStack(app, 'N', { env, config });
const desk = Template.fromStack(new UatDesktopStack(app, 'D', { env, config, vpc: net.vpc, s3Endpoint: net.s3Endpoint }));

const [janitorFn] = Object.values(desk.findResources('AWS::Lambda::Function', {
  Properties: { Description: 'Stops the UAT fleet when idle and unleased (cost safety net)' },
})) as any[];
const code: string = janitorFn.Properties.Code.ZipFile;
const lambdaEnv: Record<string, string> = janitorFn.Properties.Environment.Variables;

interface World { state?: string; lease?: string; sessions?: number; leaseMissing?: boolean }

function janitor(world: World) {
  const sent: { name: string; input: any }[] = [];
  const command = (name: string) => class { constructor(public input: any) { (this as any).name = name; } };
  const answer = (name: string, input: any) => {
    sent.push({ name, input });
    switch (name) {
      case 'DescribeFleets': return { Fleets: world.state ? [{ State: world.state }] : [] };
      case 'GetParameter':
        if (world.leaseMissing) throw Object.assign(new Error('ParameterNotFound'), { name: 'ParameterNotFound' });
        return { Parameter: { Value: world.lease ?? '0' } };
      case 'DescribeSessions': return { Sessions: Array.from({ length: world.sessions ?? 0 }, () => ({})) };
      case 'StopFleet': return {};
      default: throw new Error(`unexpected command ${name}`);
    }
  };
  const client = class { async send(c: any) { return answer(c.name, c.input); } };
  const modules: Record<string, any> = {
    '@aws-sdk/client-appstream': {
      AppStreamClient: client,
      DescribeFleetsCommand: command('DescribeFleets'),
      DescribeSessionsCommand: command('DescribeSessions'),
      StopFleetCommand: command('StopFleet'),
    },
    '@aws-sdk/client-ssm': { SSMClient: client, GetParameterCommand: command('GetParameter') },
  };
  const exports: any = {};
  const fakeRequire = (m: string) => { if (!(m in modules)) throw new Error(`require ${m}`); return modules[m]; };
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', 'process', code)(fakeRequire, exports, { env: lambdaEnv });
  return { handler: exports.handler as () => Promise<any>, sent };
}

const now = () => Math.floor(Date.now() / 1000);
const stopped = (sent: { name: string }[]) => sent.some(c => c.name === 'StopFleet');

test('it is wired to this fleet, stack and lease parameter', () => {
  expect(lambdaEnv.FLEET_NAME).toBe(config.fleet.name);
  expect(lambdaEnv.STACK_NAME).toBe(config.stack.name);
  expect(lambdaEnv.LEASE_PARAM).toMatch(/\/fleet-lease$/);
});

test('an idle, unleased, running fleet is stopped', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: '0', sessions: 0 });

  expect(await handler()).toEqual({ action: 'stopped' });
  expect(sent.find(c => c.name === 'StopFleet')!.input).toEqual({ Name: config.fleet.name });
});

test('an expired lease does not protect the fleet', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: String(now() - 60) });

  await handler();
  expect(stopped(sent)).toBe(true);
});

test('a held lease protects the fleet', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: String(now() + 3600) });

  expect(await handler()).toMatchObject({ action: 'none', reason: 'lease held' });
  expect(stopped(sent)).toBe(false);
});

test('a fleet with sessions is left alone, even unleased', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: '0', sessions: 1 });

  expect(await handler()).toMatchObject({ action: 'none', reason: 'active sessions' });
  expect(stopped(sent)).toBe(false);
});

test.each(['STOPPED', 'STARTING', 'STOPPING'])('a %s fleet is not touched', async state => {
  const { handler, sent } = janitor({ state });

  expect(await handler()).toEqual({ action: 'none', state });
  expect(sent.map(c => c.name)).toEqual(['DescribeFleets']);
});

test('a missing fleet is not an error', async () => {
  const { handler } = janitor({});

  expect(await handler()).toEqual({ action: 'none', state: undefined });
});

test('the lease parameter exists from deploy, so the janitor never reads a missing one', () => {
  desk.hasResourceProperties('AWS::SSM::Parameter', { Name: lambdaEnv.LEASE_PARAM, Value: '0' });
});

test('its role may stop only this fleet', () => {
  const stmts = Object.values(desk.findResources('AWS::IAM::Policy'))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  const stop = stmts.filter((s: any) => [s.Action].flat().includes('appstream:StopFleet'));
  expect(stop).toHaveLength(1);
  expect(JSON.stringify(stop[0].Resource)).toContain(`fleet/${config.fleet.name}`);
});
