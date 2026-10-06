import { ArchiveProvider } from '@cdktn/provider-archive/lib/provider';
import { DataAwsCallerIdentity } from '@cdktn/provider-aws/lib/data-aws-caller-identity';
import { DataAwsPartition } from '@cdktn/provider-aws/lib/data-aws-partition';
import { AwsProvider } from '@cdktn/provider-aws/lib/provider';
import { AwsccProvider } from '@cdktn/provider-awscc/lib/provider';
import { LocalBackend, TerraformElement, TerraformOutput, TerraformStack } from 'cdktn';
import { Construct, Node } from 'constructs';
import { UatConfig } from './config';
import { Desktop } from './desktop';
import { HeredocLocal, heredocLocal, unquoteReferenceLists } from './hcl';
import { Network } from './network';
import { Runners } from './runners';

export interface UatStackProps {
  config: UatConfig;
}

/**
 * One environment of desktop UAT as one Terraform root module: infra/'s three
 * stacks (network, desktop, runners) as three constructs sharing one state.
 */
export class UatStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: UatStackProps) {
    super(scope, id);
    const c = props.config;

    // Synth only, for now: state stays beside the configuration. Its home will be
    // Artifactory, which serves a Terraform backend, once this is applied for real.
    new LocalBackend(this, { path: 'terraform.tfstate' });

    new AwsProvider(this, 'aws', {
      region: c.region,
      allowedAccountIds: c.account ? [c.account] : undefined,
      defaultTags: [{ tags: { Project: 'desktop-uat', Environment: c.envName } }],
    });
    new AwsccProvider(this, 'awscc', { region: c.region });
    new ArchiveProvider(this, 'archive');

    const env = {
      partition: new DataAwsPartition(this, 'partition').partition,
      account: new DataAwsCallerIdentity(this, 'caller').accountId,
      region: c.region,
    };

    const network = new Network(this, 'network', { config: c });
    const desktop = new Desktop(this, 'desktop', { config: c, env, network });
    new Runners(this, 'runners', { config: c, env, network, desktop });

    new TerraformOutput(this, 'vpc_id', { value: network.vpc.id });
    new TerraformOutput(this, 'fleet_name', { value: c.fleet.name });
    new TerraformOutput(this, 'stack_name', { value: c.stack.name });
    new TerraformOutput(this, 'evidence_bucket', { value: desktop.evidenceBucket.bucket });
    new TerraformOutput(this, 'builds_bucket', { value: desktop.buildsBucket.bucket });
  }

  /** cdktn's HCL, with the two renderer fixes in ./hcl applied. */
  toHclTerraform(): { [key: string]: any } {
    const out = super.toHclTerraform();
    let hcl = unquoteReferenceLists(out.hcl);
    for (const local of this.node.findAll()) {
      if (local instanceof HeredocLocal) hcl = heredocLocal(hcl, local.friendlyUniqueId, local.text);
    }
    return { ...out, hcl };
  }

  /**
   * Names read as the path below the stack (`network_vpc`, `desktop_fleet`), not
   * cdktn's default path-plus-hash: the HCL is committed and read by people.
   * Construct ids are unique among siblings, so the paths are unique too.
   */
  protected allocateLogicalId(element: TerraformElement | Node): string {
    const node = element instanceof Node ? element : element.node;
    const below = node.scopes.slice(node.scopes.indexOf(this) + 1);
    return below.map(s => s.node.id).join('_').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  }
}
