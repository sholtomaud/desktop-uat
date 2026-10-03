#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { loadConfig } from '../lib/config';
import { NetworkStack } from '../lib/network-stack';
import { RunnerStack } from '../lib/runner-stack';
import { UatDesktopStack } from '../lib/uat-desktop-stack';

const app = new cdk.App();
const config = loadConfig(app.node);
const env = { account: config.account || process.env.CDK_DEFAULT_ACCOUNT, region: config.region };
const p = `DesktopUat-${config.envName}`;

const network = new NetworkStack(app, `${p}-Network`, { env, config });

const desktop = new UatDesktopStack(app, `${p}-Desktop`, {
  env, config, vpc: network.vpc, s3Endpoint: network.s3Endpoint,
});

new RunnerStack(app, `${p}-Runners`, {
  env, config,
  vpc: network.vpc,
  key: desktop.key,
  evidenceBucket: desktop.evidenceBucket,
  buildsBucket: desktop.buildsBucket,
  fleetArn: desktop.fleetArn(config.fleet.name),
  stackArn: desktop.stackArn(config.stack.name),
});

cdk.Tags.of(app).add('Project', 'desktop-uat');
cdk.Tags.of(app).add('Environment', config.envName);
