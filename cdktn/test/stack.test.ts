/**
 * The minimal, non-agentic deployment: ephemeral Windows instances in an existing
 * VPC, run by script and used by people. Everything environment-specific is a
 * Terraform variable, so one module serves every environment from its .tfvars.
 */
import {
  allows, asList, only, ref, resources, statementsOf, synth, v,
} from './support';

const { tf } = synth();

describe('inputs', () => {
  test.each([
    'region', 'allowed_account_ids', 'environment', 'vpc_id', 'subnet_ids', 'rdp_cidrs', 'ad_cidrs',
    'ad_domain', 'ad_join_ou', 'ad_join_secret_name', 'ad_tester_group', 'ami_parameter', 'artifactory_token_secret_name',
  ])('%s is a described variable', name => {
    expect(tf.variable[name]).toMatchObject({ description: expect.stringMatching(/^.{20,}$/) });
  });

  test('defaults exist only where a sensible one does', () => {
    for (const required of ['region', 'allowed_account_ids', 'vpc_id', 'subnet_ids', 'rdp_cidrs', 'ad_cidrs',
      'ad_domain', 'ad_join_ou', 'ad_join_secret_name', 'ad_tester_group', 'artifactory_token_secret_name']) {
      expect(tf.variable[required].default).toBeUndefined();
    }
    expect(tf.variable.environment.default).toBe('uat');
    expect(tf.variable.instance_type.default).toBe('m7i.large');
  });

  test('environment is validated: it goes into every name', () => {
    expect(tf.variable.environment.validation).toEqual([expect.objectContaining({
      condition: '${can(regex("^[a-z0-9-]{2,16}$", var.environment))}',
    })]);
  });

  test('the provider refuses any account but the allowed ones, and tags everything', () => {
    expect(tf.provider.aws[0]).toMatchObject({
      region: v('region'),
      allowed_account_ids: v('allowed_account_ids'),
      default_tags: [{ tags: { Project: 'desktop-uat', Environment: v('environment') } }],
    });
  });

  test('no network is created: the VPC is the workplace\'s', () => {
    for (const type of ['aws_vpc', 'aws_subnet', 'aws_nat_gateway', 'aws_internet_gateway', 'aws_route_table']) {
      expect(resources(tf, type)).toEqual({});
    }
  });
});

describe('storage', () => {
  const [bucket, b] = only(tf, 'aws_s3_bucket');
  const of = (type: string) => only(tf, type)[1];

  test('one bucket, named for the environment, kept from accidental destroy', () => {
    expect(b).toMatchObject({ bucket_prefix: `desktop-uat-${v('environment')}-`, lifecycle: { prevent_destroy: true } });
  });

  test('all public access blocked; encrypted', () => {
    expect(of('aws_s3_bucket_public_access_block')).toMatchObject({
      bucket: ref('aws_s3_bucket', bucket, 'id'),
      block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true,
    });
    expect(of('aws_s3_bucket_server_side_encryption_configuration').rule[0].apply_server_side_encryption_by_default)
      .toEqual({ sse_algorithm: 'AES256' });
  });

  test('staged builds and run reports expire on their own schedules', () => {
    const rules = of('aws_s3_bucket_lifecycle_configuration').rule;
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'Enabled', filter: [{ prefix: 'staging/' }], expiration: [{ days: v('staging_retention_days') }] }),
      expect.objectContaining({ status: 'Enabled', filter: [{ prefix: 'runs/' }], expiration: [{ days: v('run_retention_days') }] }),
    ]));
  });

  test('anything but TLS is refused', () => {
    const deny = statementsOf(tf, of('aws_s3_bucket_policy').policy).find((s: any) => s.sid === 'DenyInsecureTransport');
    expect(deny).toMatchObject({
      effect: 'Deny', actions: ['s3:*'],
      condition: [{ test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }],
    });
  });
});

describe('the desktop instance', () => {
  const [lt, t] = only(tf, 'aws_launch_template');
  const [role] = Object.entries(resources(tf, 'aws_iam_role')).find(([n]) => n.startsWith('desktop_'))!;
  const permissions = statementsOf(tf, (Object.values(resources(tf, 'aws_iam_role_policy')) as any[])
    .find(p => p.role === ref('aws_iam_role', role, 'name')).policy);

  test('boots the baked image, resolved by EC2 at launch from its SSM parameter', () => {
    expect(t.image_id).toBe(`resolve:ssm:${v('ami_parameter')}`);
    expect(t.instance_type).toBe(v('instance_type'));
  });

  test('terminates when Windows shuts down: the TTL shutdown is the clean-up', () => {
    expect(t.instance_initiated_shutdown_behavior).toBe('terminate');
  });

  test('IMDSv2 only, with instance tags readable (the boot script reads its TTL tag)', () => {
    expect(t.metadata_options).toMatchObject({
      http_endpoint: 'enabled', http_tokens: 'required', http_put_response_hop_limit: 1, instance_metadata_tags: 'enabled',
    });
  });

  test('an encrypted gp3 root volume of the configured size', () => {
    expect(t.block_device_mappings).toEqual([{
      device_name: '/dev/sda1',
      ebs: { encrypted: 'true', volume_size: v('root_volume_gb'), volume_type: 'gp3', delete_on_termination: 'true' },
    }]);
  });

  test('instances and volumes carry the Purpose tag the operator policy keys on', () => {
    for (const type of ['instance', 'volume']) {
      expect(t.tag_specifications).toContainEqual({ resource_type: type, tags: { Purpose: `desktop-uat-${v('environment')}` } });
    }
  });

  test('user data runs the baked boot script on every boot', () => {
    const [config] = param('ec2-config');
    expect(t.user_data).toBe(
      `\${base64encode("<powershell>& 'C:/Uat/Uat-Boot.ps1' -ConfigParameter '${ref('aws_ssm_parameter', config, 'name')}'</powershell><persist>true</persist>")}`);
  });

  test('the security group admits RDP from the corporate networks only', () => {
    const [sg] = t.vpc_security_group_ids;
    const ingress = (Object.values(resources(tf, 'aws_vpc_security_group_ingress_rule')) as any[]).filter(r => r.security_group_id === sg);
    expect(ingress).toEqual([expect.objectContaining({
      for_each: `\${toset(${v('rdp_cidrs').slice(2, -1)})}`, cidr_ipv4: '${each.value}', ip_protocol: 'tcp', from_port: 3389, to_port: 3389,
    })]);
  });

  test('egress: HTTPS anywhere (SSM, S3, the build), everything to the domain controllers', () => {
    const [sg] = t.vpc_security_group_ids;
    const egress = (Object.values(resources(tf, 'aws_vpc_security_group_egress_rule')) as any[]).filter(r => r.security_group_id === sg);
    expect(egress).toHaveLength(2);
    expect(egress).toContainEqual(expect.objectContaining({ cidr_ipv4: '0.0.0.0/0', ip_protocol: 'tcp', from_port: 443, to_port: 443 }));
    expect(egress).toContainEqual(expect.objectContaining({ for_each: `\${toset(${v('ad_cidrs').slice(2, -1)})}`, cidr_ipv4: '${each.value}', ip_protocol: '-1' }));
  });

  test('its role: SSM, its config, the join secret, and writing run reports; nothing else', () => {
    const [config] = param('ec2-config');
    const [bucket] = only(tf, 'aws_s3_bucket');
    const attached = (Object.values(resources(tf, 'aws_iam_role_policy_attachment')) as any[])
      .filter(a => a.role === ref('aws_iam_role', role, 'name')).map(a => a.policy_arn);
    expect(attached).toEqual([expect.stringMatching(/:policy\/AmazonSSMManagedInstanceCore$/)]);
    expect(allows(permissions, 'ssm:GetParameter', ref('aws_ssm_parameter', config, 'arn'))).toBe(true);
    expect(allows(permissions, 'secretsmanager:GetSecretValue', `:secret:${v('ad_join_secret_name')}-??????`)).toBe(true);
    expect(allows(permissions, 's3:PutObject', `${ref('aws_s3_bucket', bucket, 'arn')}/runs/*`)).toBe(true);
    expect(allows(permissions, 's3:GetObject', ref('aws_s3_bucket', bucket, 'arn'))).toBe(false);
    expect(permissions.flatMap((s: any) => asList(s.actions)).sort()).toEqual(
      ['s3:PutObject', 'secretsmanager:GetSecretValue', 'ssm:GetParameter']);
  });

  test('the launch template uses that role', () => {
    const profiles = resources(tf, 'aws_iam_instance_profile');
    const profile = Object.keys(profiles).find(n => profiles[n].role === ref('aws_iam_role', role, 'name'))!;
    expect(t.iam_instance_profile).toEqual({ arn: ref('aws_iam_instance_profile', profile, 'arn') });
    void lt;
  });
});

const param = (suffix: string): [string, any] =>
  Object.entries(resources(tf, 'aws_ssm_parameter')).find(([, p]: [string, any]) => p.name === `/desktop-uat/${v('environment')}/${suffix}`)!;

describe('the config parameter', () => {
  const [, p] = param('ec2-config');

  test('is named for the environment', () => {
    expect(p).toMatchObject({ name: `/desktop-uat/${v('environment')}/ec2-config`, type: 'String' });
  });

  test('carries the domain join, the tester group and where reports go', () => {
    const [bucket] = only(tf, 'aws_s3_bucket');
    for (const [key, value] of Object.entries({
      Domain: 'var.ad_domain', JoinOu: 'var.ad_join_ou', JoinSecretId: 'var.ad_join_secret_name',
      TesterGroup: 'var.ad_tester_group', Bucket: `aws_s3_bucket.${bucket}.bucket`, Region: 'var.region',
    })) {
      expect(p.value).toContain(`"${key}" = ${value}`);
    }
    expect(p.value).toMatch(/^\$\{jsonencode\(\{/);
  });
});

describe('the operator: whoever runs scripts/ec2-uat.sh', () => {
  const [, policy] = only(tf, 'aws_iam_policy');
  const s = statementsOf(tf, policy.policy);
  const sid = (id: string) => s.find((x: any) => x.sid === id);
  const [lt] = only(tf, 'aws_launch_template');

  test('launches only from this launch template', () => {
    expect(sid('RunFromTemplate')).toMatchObject({
      actions: ['ec2:RunInstances'], resources: ['*'],
      condition: [{ test: 'ArnLike', variable: 'ec2:LaunchTemplate', values: [ref('aws_launch_template', lt, 'arn')] }],
    });
  });

  test('may hand the instance its role, and read the image parameter EC2 resolves', () => {
    const [role] = Object.entries(resources(tf, 'aws_iam_role')).find(([n]) => n.startsWith('desktop_'))!;
    expect(allows(s, 'iam:PassRole', ref('aws_iam_role', role, 'arn'))).toBe(true);
    expect(allows(s, 'ssm:GetParameters', `parameter${v('ami_parameter')}`)).toBe(true);
  });

  test('terminates and commands only instances carrying this environment\'s Purpose tag', () => {
    for (const id of ['Terminate', 'CommandInstances']) {
      expect(sid(id).condition).toEqual([{ test: 'StringEquals', variable: 'aws:ResourceTag/Purpose', values: [`desktop-uat-${v('environment')}`] }]);
    }
    expect(sid('Terminate').actions).toEqual(['ec2:TerminateInstances']);
  });

  test('may run only the two desktop-uat documents', () => {
    const docs = Object.keys(resources(tf, 'aws_ssm_document')).map(n => ref('aws_ssm_document', n, 'arn')).sort();
    expect(sid('CommandDocuments')).toMatchObject({ actions: ['ssm:SendCommand'] });
    expect([...sid('CommandDocuments').resources].sort()).toEqual(docs);
  });

  test('stages into staging/, reads runs/, and may presign both', () => {
    const [bucket] = only(tf, 'aws_s3_bucket');
    const arn = ref('aws_s3_bucket', bucket, 'arn');
    expect(allows(s, 's3:PutObject', `${arn}/staging/*`)).toBe(true);
    expect(allows(s, 's3:GetObject', `${arn}/staging/*`)).toBe(true);
    expect(allows(s, 's3:GetObject', `${arn}/runs/*`)).toBe(true);
    expect(allows(s, 's3:PutObject', `${arn}/runs/*`)).toBe(false);
  });

  test('is a managed policy, for attaching to the GHES runner role', () => {
    expect(policy.name).toBe(`desktop-uat-${v('environment')}-operator`);
    expect(tf.output.operator_policy_arn.value).toBe(ref('aws_iam_policy', only(tf, 'aws_iam_policy')[0], 'arn'));
  });
});

describe('the discovery parameter: how ec2-uat.sh finds everything, with no Terraform state', () => {
  const [name, p] = param('ec2-operator');

  test('names the launch template, the subnets, the bucket and both documents', () => {
    const [lt] = only(tf, 'aws_launch_template');
    const [bucket] = only(tf, 'aws_s3_bucket');
    for (const [key, value] of Object.entries({
      LaunchTemplateId: `aws_launch_template.${lt}.id`,
      SubnetIds: 'var.subnet_ids',
      Bucket: `aws_s3_bucket.${bucket}.bucket`,
      RunDocument: 'aws_ssm_document.run_run.name',
      LeaveDocument: 'aws_ssm_document.run_leave.name',
      Region: 'var.region',
      Purpose: '"desktop-uat-${var.environment}"',
    })) {
      expect(p.value).toContain(`"${key}" = ${value}`);
    }
  });

  test('the operator may read it', () => {
    const [, policy] = only(tf, 'aws_iam_policy');
    expect(allows(statementsOf(tf, policy.policy), 'ssm:GetParameter', ref('aws_ssm_parameter', name, 'arn'))).toBe(true);
  });

  test('the instances may not: it is the operator\'s', () => {
    const [role] = Object.entries(resources(tf, 'aws_iam_role')).find(([n]) => n.startsWith('desktop_'))!;
    const s = statementsOf(tf, (Object.values(resources(tf, 'aws_iam_role_policy')) as any[])
      .find(x => x.role === ref('aws_iam_role', role, 'name')).policy);
    expect(allows(s, 'ssm:GetParameter', ref('aws_ssm_parameter', name, 'arn'))).toBe(false);
  });
});

test('outputs: what ec2-uat.sh and its operator need', () => {
  expect(Object.keys(tf.output).sort()).toEqual([
    'bucket', 'config_parameter', 'discovery_parameter', 'launch_template_id', 'leave_document', 'operator_policy_arn',
    'run_document', 'security_group_id',
  ]);
});
