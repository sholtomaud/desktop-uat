import { Node } from 'constructs';

export type UserControlMode = 'VIEW_ONLY' | 'VIEW_STOP' | 'DISABLED';

export interface UatConfig {
  envName: string;
  account?: string;
  region: string;
  vpcCidr: string;
  maxAzs: number;
  natGateways: number;
  /** Interface endpoint service suffixes (com.amazonaws.<region>.<suffix>). */
  interfaceEndpoints: string[];
  fleet: {
    name: string;
    /** WorkSpaces Applications image built from image/Install-UatImage.ps1. */
    imageName: string;
    instanceType: string;
    /** On-demand capacity == max scenarios that can run in parallel. */
    maxConcurrentSessions: number;
    maxSessionSeconds: number;
  };
  stack: {
    name: string;
    userControlMode: UserControlMode;
    screenImageFormat: 'PNG' | 'JPEG';
  };
  /** Bedrock model or inference profile id the harness uses. */
  bedrockModelId: string;
  evidenceRetentionDays: number;
  buildRetentionDays: number;
  /** Janitor stops the fleet after this many minutes with no sessions and no lease. */
  janitorIdleMinutes: number;
  createImageBuilder: boolean;
  imageBuilderBaseImage: string;
  /**
   * Release artifacts live in Artifactory. The runner pulls, checksum-verifies and
   * stages them into the builds bucket; the isolated desktops never talk to Artifactory.
   */
  artifactory: {
    /** e.g. https://artifactory.example.internal/artifactory */
    baseUrl: string;
    /** Secrets Manager secret (created out of band) with JSON {"token": "<access token>"}. */
    tokenSecretName: string;
  };
  runner: {
    ghesUrl: string;
    scope: 'org' | 'repo';
    /** Org name (scope=org) or owner/repo (scope=repo). */
    target: string;
    labels: string[];
    instanceType: string;
    minCapacity: number;
    maxCapacity: number;
    runnerVersion: string;
    /** Optional internal mirror of the actions/runner tarball. Empty = github.com release. */
    runnerDownloadUrl: string;
    /** Secrets Manager secret (created out of band) with JSON {"token": "<PAT or app token>"}. */
    tokenSecretName: string;
  };
}

function fail(msg: string): never {
  throw new Error(`Invalid "uat" context: ${msg}`);
}

export function loadConfig(node: Node): UatConfig {
  const raw = node.tryGetContext('uat') as UatConfig | undefined;
  if (!raw) fail('missing "uat" key in cdk.json context');
  const c = raw;

  if (!/^[a-z0-9-]{2,16}$/.test(c.envName)) fail('envName must be 2-16 chars [a-z0-9-]');
  if (!['VIEW_ONLY', 'VIEW_STOP', 'DISABLED'].includes(c.stack.userControlMode)) {
    fail('stack.userControlMode must be VIEW_ONLY | VIEW_STOP | DISABLED');
  }
  if (c.fleet.maxConcurrentSessions < 1 || c.fleet.maxConcurrentSessions > 20) {
    fail('fleet.maxConcurrentSessions must be 1-20');
  }
  if (c.fleet.maxSessionSeconds < 600 || c.fleet.maxSessionSeconds > 432000) {
    fail('fleet.maxSessionSeconds must be 600-432000');
  }
  if (!c.runner.ghesUrl.startsWith('https://')) fail('runner.ghesUrl must be https://');
  if (c.runner.scope === 'repo' && !c.runner.target.includes('/')) {
    fail('runner.target must be owner/repo when scope=repo');
  }
  if (!c.artifactory?.baseUrl?.startsWith('https://')) fail('artifactory.baseUrl must be https://');
  if (c.runner.minCapacity > c.runner.maxCapacity) fail('runner.minCapacity > maxCapacity');
  return c;
}

/** SSM parameter prefix shared by infra, workflow and harness. */
export const ssmPrefix = (c: UatConfig) => `/desktop-uat/${c.envName}`;
