import { DataAwsPartition } from '@cdktn/provider-aws/lib/data-aws-partition';
import { AwsProvider } from '@cdktn/provider-aws/lib/provider';
import { LocalBackend, TerraformElement, TerraformOutput, TerraformStack, TerraformVariable } from 'cdktn';
import { Construct, Node } from 'constructs';
import { Desktop } from './desktop';
import { Documents } from './documents';
import { unquoteReferenceLists } from './hcl';
import { Operator } from './operator';
import { Storage } from './storage';

/** The module's inputs, as Terraform variables: one module, a .tfvars per environment. */
export interface Inputs {
  region: TerraformVariable;
  allowedAccountIds: TerraformVariable;
  environment: TerraformVariable;
  vpcId: TerraformVariable;
  subnetIds: TerraformVariable;
  rdpCidrs: TerraformVariable;
  adCidrs: TerraformVariable;
  adDomain: TerraformVariable;
  adJoinOu: TerraformVariable;
  adJoinSecretName: TerraformVariable;
  adTesterGroup: TerraformVariable;
  amiParameter: TerraformVariable;
  instanceType: TerraformVariable;
  rootVolumeGb: TerraformVariable;
  stagingRetentionDays: TerraformVariable;
  runRetentionDays: TerraformVariable;
}

/**
 * Desktop UAT without the agent: ephemeral Windows instances, from a baked
 * image, in an existing VPC. scripts/ec2-uat.sh launches one, runs scenarios in
 * its desktop session through SSM, and leaves it up for testers to RDP into with
 * their AD accounts; it terminates itself at its TTL. infra/ is the AppStream,
 * agent-driven alternative.
 */
export class UatStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Synth only, for now: state stays beside the configuration. Its home will be
    // Artifactory, which serves a Terraform backend, once this is applied for real.
    new LocalBackend(this, { path: 'terraform.tfstate' });

    const inputs = variables(this);
    new AwsProvider(this, 'aws', {
      region: inputs.region.stringValue,
      allowedAccountIds: inputs.allowedAccountIds.listValue,
      defaultTags: [{ tags: { Project: 'desktop-uat', Environment: inputs.environment.stringValue } }],
    });
    const partition = new DataAwsPartition(this, 'partition').partition;

    const storage = new Storage(this, 'storage', { inputs });
    const desktop = new Desktop(this, 'desktop', { inputs, partition, bucket: storage.bucket });
    const documents = new Documents(this, 'run', { inputs });
    const operator = new Operator(this, 'operator', { inputs, partition, storage, desktop, documents });

    const out = (id: string, value: string, description: string) => new TerraformOutput(this, id, { value, description });
    out('bucket', storage.bucket.bucket, 'Builds are staged under staging/, reports land under runs/<run id>/');
    out('launch_template_id', desktop.launchTemplate.id, 'What ec2-uat.sh launches');
    out('security_group_id', desktop.securityGroup.id, 'The instances\' security group');
    out('config_parameter', desktop.config.name, 'SSM parameter the boot script reads its settings from');
    out('discovery_parameter', operator.discovery.name, 'SSM parameter ec2-uat.sh finds everything else from');
    out('run_document', documents.run.name, 'SSM document: one scripted UAT run');
    out('leave_document', documents.leave.name, 'SSM document: leave the domain before termination');
    out('operator_policy_arn', operator.policy.arn, 'Attach to whatever runs ec2-uat.sh, e.g. the GHES runner role');
  }

  /** cdktn's HCL, with the renderer fix in ./hcl applied. */
  toHclTerraform(): { [key: string]: any } {
    const out = super.toHclTerraform();
    return { ...out, hcl: unquoteReferenceLists(out.hcl) };
  }

  /**
   * Names read as the path below the stack (`storage_bucket`, `desktop_lt`), not
   * cdktn's default path-plus-hash: the HCL is committed and read by people.
   * Construct ids are unique among siblings, so the paths are unique too.
   */
  protected allocateLogicalId(element: TerraformElement | Node): string {
    const node = element instanceof Node ? element : element.node;
    const below = node.scopes.slice(node.scopes.indexOf(this) + 1);
    return below.map(s => s.node.id).join('_').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
  }
}

function variables(scope: Construct): Inputs {
  const s = (id: string, description: string, defaultValue?: string) =>
    new TerraformVariable(scope, id, { type: 'string', description, default: defaultValue });
  const list = (id: string, description: string) =>
    new TerraformVariable(scope, id, { type: 'list(string)', description });
  const n = (id: string, description: string, defaultValue: number) =>
    new TerraformVariable(scope, id, { type: 'number', description, default: defaultValue });

  return {
    region: s('region', 'AWS region, e.g. ap-southeast-2'),
    allowedAccountIds: list('allowed_account_ids', 'The only AWS account ids this may be applied to'),
    environment: new TerraformVariable(scope, 'environment', {
      type: 'string',
      description: 'Environment name, part of every resource name: 2-16 of [a-z0-9-]',
      default: 'uat',
      validation: [{
        // An expression, not a string: written as an interpolation, which tofu fmt unwraps.
        condition: '${can(regex("^[a-z0-9-]{2,16}$", var.environment))}',
        errorMessage: 'environment must be 2-16 characters of [a-z0-9-].',
      }],
    }),
    vpcId: s('vpc_id', 'The existing VPC the instances run in'),
    subnetIds: list('subnet_ids', 'Private subnets of that VPC; they must reach SSM, S3, Artifactory and the domain controllers'),
    rdpCidrs: list('rdp_cidrs', 'Corporate networks testers RDP in from (TCP 3389)'),
    adCidrs: list('ad_cidrs', 'The domain controllers, for the domain join and logons (all traffic)'),
    adDomain: s('ad_domain', 'The AD domain instances join, e.g. corp.example.com'),
    adJoinOu: s('ad_join_ou', 'OU the computer objects go in, e.g. OU=UAT,OU=Computers,DC=corp,DC=example,DC=com'),
    adJoinSecretName: s('ad_join_secret_name',
      'Secrets Manager secret (created out of band) with JSON {"username","password"} of an account that may only join computers to that OU'),
    adTesterGroup: s('ad_tester_group', 'AD group whose members may RDP in, by name in that domain, e.g. UAT-Testers'),
    amiParameter: s('ami_parameter', 'SSM parameter holding the baked image id (image/ec2/Build-UatEc2Image.ps1 publishes it)',
      '/desktop-uat/ami/windows'),
    instanceType: s('instance_type', 'Instance type for the desktops', 'm7i.large'),
    rootVolumeGb: n('root_volume_gb', 'Root volume size in GiB', 100),
    stagingRetentionDays: n('staging_retention_days', 'Days staged builds and scenarios are kept', 14),
    runRetentionDays: n('run_retention_days', 'Days run reports and screenshots are kept', 180),
  };
}
