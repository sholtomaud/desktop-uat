/**
 * The fleet janitor: the cost safety net that stops a fleet a cancelled job left
 * running. Its code is inline in the configuration (archive_file packs it at plan
 * time), so the test takes it from there — exactly what Lambda would run — and
 * executes it against a fake AWS SDK. The same cases as infra/test/janitor.test.ts.
 */
import { config, dataSources, only, resources, synth } from './support';

const { tf } = synth();
const [, fn] = only(tf, 'aws_lambda_function');
const archive = fn.filename.match(/^\$\{data\.archive_file\.([a-z0-9_]+)\.output_path\}$/)[1];
const [source] = dataSources(tf, 'archive_file')[archive].source;
const code: string = source.content;
const lambdaEnv: Record<string, string> = fn.environment.variables;

interface World { state?: string; lease?: string; sessions?: number }

function janitor(world: World) {
  const sent: { name: string; input: any }[] = [];
  const command = (name: string) => class { constructor(public input: any) { (this as any).name = name; } };
  const answer = (name: string, input: any) => {
    sent.push({ name, input });
    switch (name) {
      case 'DescribeFleets': return { Fleets: world.state ? [{ State: world.state }] : [] };
      case 'GetParameter': return { Parameter: { Value: world.lease ?? '0' } };
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

test('it is packed as index.js for the index.handler entry point, on Node 24', () => {
  expect(source.filename).toBe('index.js');
  expect(fn).toMatchObject({ handler: 'index.handler', runtime: 'nodejs24.x', timeout: 60 });
});

test('it is wired to this fleet, stack and lease parameter', () => {
  expect(lambdaEnv.FLEET_NAME).toBe(config.fleet.name);
  expect(lambdaEnv.STACK_NAME).toBe(config.stack.name);
  expect(lambdaEnv.LEASE_PARAM).toBe(`/desktop-uat/${config.envName}/fleet-lease`);
});

test('the lease parameter it reads exists from the first apply', () => {
  expect((Object.values(resources(tf, 'aws_ssm_parameter')) as any[]).map(p => p.name)).toContain(lambdaEnv.LEASE_PARAM);
});

let logged: string[];
beforeEach(() => {
  logged = [];
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
});
afterEach(() => jest.restoreAllMocks());

test('an idle, unleased, running fleet is stopped, with one structured log line', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: '0', sessions: 0 });

  expect(await handler()).toEqual({ action: 'stopped' });
  expect(sent.find(c => c.name === 'StopFleet')!.input).toEqual({ Name: config.fleet.name });
  expect(logged.map(l => JSON.parse(l))).toEqual([{ action: 'stopped', fleet: config.fleet.name }]);
});

test('an expired lease does not protect the fleet', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: String(now() - 60) });

  await handler();
  expect(stopped(sent)).toBe(true);
});

test('a held lease protects the fleet, and nothing is logged', async () => {
  const { handler, sent } = janitor({ state: 'RUNNING', lease: String(now() + 3600) });

  expect(await handler()).toMatchObject({ action: 'none', reason: 'lease held' });
  expect(stopped(sent)).toBe(false);
  expect(logged).toEqual([]);
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
  expect(await janitor({}).handler()).toEqual({ action: 'none', state: undefined });
});
