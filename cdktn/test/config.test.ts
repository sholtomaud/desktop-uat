/**
 * cdktn/ describes the same deployment as infra/, from the same settings: the
 * "uat" context in infra/cdk.json and the AZs committed in infra/cdk.context.json.
 * One copy of the settings, so the two cannot drift apart.
 */
import { allocateSubnets, availabilityZones, uatConfig } from '../lib/config';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cdkJson = require('../../infra/cdk.json');

test('the settings are infra/cdk.json\'s, validated by infra\'s own loader', () => {
  expect(uatConfig()).toEqual(cdkJson.context.uat);
  const bad = { ...cdkJson.context.uat, envName: 'Not Valid' };
  expect(() => uatConfig(bad)).toThrow(/envName/);
});

test('AZs come from the committed lookup, as many as maxAzs', () => {
  expect(availabilityZones(uatConfig())).toEqual(['ap-southeast-2a', 'ap-southeast-2b']);
});

test('a region with no committed AZ lookup fails loudly, naming the file to fix', () => {
  expect(() => availabilityZones({ ...uatConfig(), region: 'eu-west-9' }))
    .toThrow(/infra\/cdk\.context\.json/);
});

describe('subnet allocation', () => {
  const groups = [
    { name: 'public', mask: 26 },
    { name: 'runners', mask: 24 },
    { name: 'fleet', mask: 22 },
  ];

  test('each group gets one aligned block per AZ, in order, as the CDK lays them out', () => {
    expect(allocateSubnets('10.60.0.0/16', groups, 2)).toEqual({
      public: ['10.60.0.0/26', '10.60.0.64/26'],
      runners: ['10.60.1.0/24', '10.60.2.0/24'],
      fleet: ['10.60.4.0/22', '10.60.8.0/22'],
    });
  });

  test('a VPC too small for the layout is refused', () => {
    expect(() => allocateSubnets('10.60.0.0/24', groups, 2)).toThrow(/does not fit/);
  });
});
