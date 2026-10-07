import { SsmDocument } from '@cdktn/provider-aws/lib/ssm-document';
import { Construct } from 'constructs';
import { UAT_ROOT } from './desktop';
import { heredocSafe } from './hcl';
import type { Inputs } from './uat-stack';

/**
 * SSM substitutes {{ Parameter }} into the command text as is, and the command
 * puts each value in a single-quoted PowerShell string. So each pattern admits
 * no quote, backtick or newline: nothing can end the string early. They are
 * written without backslashes, which cdktn's HCL output would not escape.
 */
const PATTERNS: Record<string, { pattern: string; description: string; default?: string }> = {
  RunId: { pattern: '^[A-Za-z0-9._-]{1,64}$', description: 'Run id; reports go to runs/<RunId>/' },
  BuildUrl: { pattern: '^https://[-A-Za-z0-9.]+/[-A-Za-z0-9/._~%&=+:?]*$', description: 'Presigned HTTPS URL of the build zip' },
  BuildSha256: { pattern: '^[a-f0-9]{64}$', description: 'SHA-256 the build must have' },
  ScenariosUrl: { pattern: '^https://[-A-Za-z0-9.]+/[-A-Za-z0-9/._~%&=+:?]*$', description: 'Presigned HTTPS URL of the scenarios zip' },
  Tags: { pattern: '^[A-Za-z0-9,_-]*$', description: 'Only scenarios with one of these tags; empty for all', default: '' },
  StateRoot: { pattern: '^[A-Za-z0-9%:/ ._-]{1,200}$', description: 'What reset_app_state may delete, e.g. %APPDATA%/UatDemo' },
  GitRef: { pattern: '^[A-Za-z0-9/._-]{0,200}$', description: 'For the report', default: '' },
  GitSha: { pattern: '^[a-f0-9]{0,40}$', description: 'For the report', default: '' },
};

/** The two commands scripts/ec2-uat.sh sends to an instance. */
export class Documents extends Construct {
  public readonly run: SsmDocument;
  public readonly leave: SsmDocument;

  constructor(scope: Construct, id: string, props: { inputs: Inputs }) {
    super(scope, id);
    const env = props.inputs.environment.stringValue;

    const args = Object.keys(PATTERNS).map(name => `-${name} '{{ ${name} }}'`).join(' ');
    this.run = command(this, 'run', `desktop-uat-${env}-run`, {
      description: 'Desktop UAT: one scripted run in the desktop session, reports to S3',
      parameters: Object.fromEntries(Object.entries(PATTERNS).map(([name, p]) => [name, {
        type: 'String', description: p.description, allowedPattern: p.pattern,
        ...(p.default !== undefined ? { default: p.default } : {}),
      }])),
      // A run includes installing the build; the harness's own timeouts are shorter.
      timeoutSeconds: '7200',
      command: `& '${UAT_ROOT}/Uat-Run.ps1' ${args}; exit $LASTEXITCODE`,
    });

    this.leave = command(this, 'leave', `desktop-uat-${env}-leave`, {
      description: 'Desktop UAT: leave the domain, removing the computer object, before termination',
      timeoutSeconds: '600',
      command: `& '${UAT_ROOT}/Uat-Leave.ps1'; exit $LASTEXITCODE`,
    });
  }
}

interface CommandSpec {
  description: string;
  parameters?: Record<string, unknown>;
  timeoutSeconds: string;
  command: string;
}

function command(scope: Construct, id: string, name: string, spec: CommandSpec): SsmDocument {
  const content = {
    schemaVersion: '2.2',
    description: spec.description,
    ...(spec.parameters ? { parameters: spec.parameters } : {}),
    mainSteps: [{
      action: 'aws:runPowerShellScript',
      name: id,
      inputs: { timeoutSeconds: spec.timeoutSeconds, runCommand: [spec.command] },
    }],
  };
  return new SsmDocument(scope, id, {
    name,
    documentType: 'Command',
    documentFormat: 'JSON',
    // Indented, so the committed HCL shows it as a readable heredoc.
    content: heredocSafe(JSON.stringify(content, null, 2)),
  });
}
