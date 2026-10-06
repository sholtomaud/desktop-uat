/**
 * The WorkSpaces Applications fleet, its agent-enabled stack, the buckets and
 * the SSM parameters: infra/lib/uat-desktop-stack.ts, as plain Terraform.
 */
import { config, dataSources, only, ref, resources, roleStatements, synth } from './support';

const { tf } = synth();
const buckets = resources(tf, 'aws_s3_bucket');
const bucketNamed = (role: string) => Object.keys(buckets).find(n => buckets[n].bucket_prefix.includes(`-${role}-`))!;
const forBucket = (type: string, bucket: string) =>
  (Object.values(resources(tf, type)) as any[]).find(r => r.bucket === ref('aws_s3_bucket', bucket, 'id'));
const policyOf = (bucket: string) => {
  const p = forBucket('aws_s3_bucket_policy', bucket);
  const doc = p.policy.match(/^\$\{data\.aws_iam_policy_document\.([a-z0-9_]+)\.json\}$/)[1];
  return dataSources(tf, 'aws_iam_policy_document')[doc].statement as any[];
};
const fleetSubnets = Object.keys(resources(tf, 'aws_subnet'))
  .filter(n => resources(tf, 'aws_subnet')[n].tags.Tier === 'fleet');

describe('the agent-enabled stack', () => {
  const [, stack] = only(tf, 'awscc_appstream_stack');

  test('enables agent access with VIEW_STOP, screenshots and MCP forwarding', () => {
    expect(stack.name).toBe(config.stack.name);
    expect(stack.agent_access_config).toMatchObject({
      user_control_mode: 'VIEW_STOP',
      screen_resolution: 'W_1280xH_720',
      screen_image_format: config.stack.screenImageFormat,
      screenshots_upload_enabled: true,
      s3_bucket_arn: ref('aws_s3_bucket', bucketNamed('evidence'), 'arn'),
    });
    expect(stack.agent_access_config.settings).toEqual(expect.arrayContaining([
      { agent_action: 'COMPUTER_VISION', permission: 'ENABLED' },
      { agent_action: 'COMPUTER_INPUT', permission: 'ENABLED' },
      { agent_action: 'FORWARD_MCP_TOOLS', permission: 'ENABLED' },
    ]));
  });
});

test('the fleet is on-demand, desktop view, no internet, in the isolated tier', () => {
  const [, fleet] = only(tf, 'aws_appstream_fleet');
  expect(fleet).toMatchObject({
    name: config.fleet.name,
    fleet_type: 'ON_DEMAND',
    stream_view: 'DESKTOP',
    enable_default_internet_access: false,
    instance_type: config.fleet.instanceType,
    image_name: config.fleet.imageName,
    max_user_duration_in_seconds: config.fleet.maxSessionSeconds,
    compute_capacity: { desired_instances: config.fleet.maxConcurrentSessions },
  });
  expect([...fleet.vpc_config.subnet_ids].sort()).toEqual(fleetSubnets.map(n => ref('aws_subnet', n, 'id')).sort());
});

test('the fleet\'s group allows only HTTPS out, which only the S3 endpoint can answer', () => {
  const [, fleet] = only(tf, 'aws_appstream_fleet');
  const [sg] = fleet.vpc_config.security_group_ids;
  const egress = (Object.values(resources(tf, 'aws_vpc_security_group_egress_rule')) as any[]).filter(r => r.security_group_id === sg);
  expect(egress).toEqual([expect.objectContaining({ cidr_ipv4: '0.0.0.0/0', from_port: 443, to_port: 443, ip_protocol: 'tcp' })]);
  expect((Object.values(resources(tf, 'aws_vpc_security_group_ingress_rule')) as any[]).filter(r => r.security_group_id === sg)).toEqual([]);
});

test('the association names the fleet and stack by reference, so Terraform orders it after both', () => {
  const [, assoc] = only(tf, 'aws_appstream_fleet_stack_association');
  const [fleet] = only(tf, 'aws_appstream_fleet');
  const [stack] = only(tf, 'awscc_appstream_stack');
  expect(assoc.fleet_name).toBe(ref('aws_appstream_fleet', fleet, 'name'));
  expect(assoc.stack_name).toBe(ref('awscc_appstream_stack', stack, 'name'));
});

describe('buckets', () => {
  test('there are three: access logs, evidence, builds', () => {
    expect(Object.keys(buckets)).toHaveLength(3);
    for (const role of ['access-logs', 'evidence', 'builds']) expect(bucketNamed(role)).toBeDefined();
  });

  test.each(['access-logs', 'evidence', 'builds'])('%s: all public access blocked', role => {
    expect(forBucket('aws_s3_bucket_public_access_block', bucketNamed(role))).toMatchObject({
      block_public_acls: true, block_public_policy: true, ignore_public_acls: true, restrict_public_buckets: true,
    });
  });

  test.each(['access-logs', 'evidence', 'builds'])('%s: refuses anything but TLS', role => {
    const deny = policyOf(bucketNamed(role)).find(s => s.sid === 'DenyInsecureTransport');
    expect(deny).toMatchObject({
      effect: 'Deny', actions: ['s3:*'],
      condition: [{ test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }],
    });
  });

  test.each(['access-logs', 'evidence', 'builds'])('%s: kept from accidental destroy', role => {
    expect(buckets[bucketNamed(role)].lifecycle).toEqual({ prevent_destroy: true });
  });

  test.each([['evidence', config.evidenceRetentionDays], ['builds', config.buildRetentionDays], ['access-logs', 365]])(
    '%s: objects expire after %i days', (role, days) => {
      const rules = forBucket('aws_s3_bucket_lifecycle_configuration', bucketNamed(role as string)).rule;
      expect(rules).toEqual([expect.objectContaining({ status: 'Enabled', expiration: [{ days }] })]);
    });

  test.each(['evidence', 'builds'])('%s: encrypted with the stack key, bucket key on, access-logged', role => {
    const [key] = only(tf, 'aws_kms_key');
    const sse = forBucket('aws_s3_bucket_server_side_encryption_configuration', bucketNamed(role)).rule[0];
    expect(sse.bucket_key_enabled).toBe(true);
    expect(sse.apply_server_side_encryption_by_default).toEqual({ sse_algorithm: 'aws:kms', kms_master_key_id: ref('aws_kms_key', key, 'arn') });
    expect(forBucket('aws_s3_bucket_logging', bucketNamed(role))).toMatchObject({
      target_bucket: ref('aws_s3_bucket', bucketNamed('access-logs'), 'id'), target_prefix: `${role}/`,
    });
  });

  test('access logs use S3-managed keys: server access logging cannot write to SSE-KMS', () => {
    const sse = forBucket('aws_s3_bucket_server_side_encryption_configuration', bucketNamed('access-logs')).rule[0];
    expect(sse.apply_server_side_encryption_by_default).toEqual({ sse_algorithm: 'AES256' });
    expect(policyOf(bucketNamed('access-logs')).find(s => s.sid === 'S3ServerAccessLogs')).toMatchObject({
      actions: ['s3:PutObject'], principals: [{ type: 'Service', identifiers: ['logging.s3.amazonaws.com'] }],
    });
  });

  test('builds can be read only through the VPC\'s S3 gateway endpoint', () => {
    const s3 = Object.keys(resources(tf, 'aws_vpc_endpoint'))
      .find(n => resources(tf, 'aws_vpc_endpoint')[n].vpc_endpoint_type === 'Gateway')!;
    expect(policyOf(bucketNamed('builds')).find(s => s.sid === 'DenyGetOutsideVpc')).toMatchObject({
      effect: 'Deny', actions: ['s3:GetObject'],
      principals: [{ type: '*', identifiers: ['*'] }],
      condition: [{ test: 'StringNotEquals', variable: 'aws:SourceVpce', values: [ref('aws_vpc_endpoint', s3, 'id')] }],
    });
  });

  test('evidence can be listed by the AppStream service, from this account only', () => {
    expect(policyOf(bucketNamed('evidence')).find(s => s.sid === 'AppStreamAgentAccessList')).toMatchObject({
      actions: ['s3:ListBucket', 's3:GetBucketLocation'],
      principals: [{ type: 'Service', identifiers: ['appstream.amazonaws.com'] }],
      condition: [expect.objectContaining({ test: 'StringEquals', variable: 'aws:SourceAccount' })],
    });
  });
});

test('the key rotates and is kept from accidental destroy', () => {
  const [name, key] = only(tf, 'aws_kms_key');
  expect(key).toMatchObject({ enable_key_rotation: true, lifecycle: { prevent_destroy: true } });
  const [, alias] = only(tf, 'aws_kms_alias');
  expect(alias).toMatchObject({ name: `alias/desktop-uat-${config.envName}`, target_key_id: ref('aws_kms_key', name, 'key_id') });
});

describe('SSM parameters', () => {
  const params = Object.values(resources(tf, 'aws_ssm_parameter')) as any[];
  const named = (n: string) => params.find(p => p.name === `/desktop-uat/${config.envName}/${n}`);

  test('the lease starts at 0 and Terraform never resets what the workflow writes to it', () => {
    expect(named('fleet-lease')).toMatchObject({ type: 'String', value: '0', lifecycle: { ignore_changes: ['value'] } });
  });

  test.each([
    ['region', config.region],
    ['fleet-name', config.fleet.name],
    ['stack-name', config.stack.name],
    ['bedrock-model-id', config.bedrockModelId],
    ['max-concurrent-sessions', String(config.fleet.maxConcurrentSessions)],
    ['mcp-endpoint', `https://agentaccess-mcp.${config.region}.api.aws/mcp`],
  ])('%s = %s', (name, value) => {
    expect(named(name)).toMatchObject({ type: 'String', value });
  });

  test.each(['evidence', 'builds'])('%s-bucket names the bucket', role => {
    expect(named(`${role}-bucket`).value).toBe(ref('aws_s3_bucket', bucketNamed(role), 'bucket'));
  });
});

describe('image builder', () => {
  test('is not created by default', () => {
    expect(resources(tf, 'aws_appstream_image_builder')).toEqual({});
  });

  test('when asked for, sits in the first runner subnet with egress to install things', () => {
    const { tf: withIb } = synth({ ...config, createImageBuilder: true });
    const [, ib] = only(withIb, 'aws_appstream_image_builder');
    const runner0 = Object.keys(resources(withIb, 'aws_subnet')).filter(n => resources(withIb, 'aws_subnet')[n].tags.Tier === 'runners')[0];
    expect(ib).toMatchObject({
      name: `desktop-uat-ib-${config.envName}`,
      image_name: config.imageBuilderBaseImage,
      enable_default_internet_access: false,
      vpc_config: { subnet_ids: [ref('aws_subnet', runner0, 'id')] },
    });
  });
});

describe('the janitor\'s wiring', () => {
  const [fn, lambda] = only(tf, 'aws_lambda_function');

  test('runs on a schedule of max(15, idle/3) minutes', () => {
    const [rule, r] = only(tf, 'aws_cloudwatch_event_rule');
    expect(r.schedule_expression).toBe(`rate(${Math.max(15, Math.floor(config.janitorIdleMinutes / 3))} minutes)`);
    const [, target] = only(tf, 'aws_cloudwatch_event_target');
    expect(target).toMatchObject({ rule: ref('aws_cloudwatch_event_rule', rule, 'name'), arn: ref('aws_lambda_function', fn, 'arn') });
    const [, perm] = only(tf, 'aws_lambda_permission');
    expect(perm).toMatchObject({
      action: 'lambda:InvokeFunction', principal: 'events.amazonaws.com',
      function_name: ref('aws_lambda_function', fn, 'function_name'),
      source_arn: ref('aws_cloudwatch_event_rule', rule, 'arn'),
    });
  });

  test('logs to its own group, kept 90 days', () => {
    const groups = resources(tf, 'aws_cloudwatch_log_group');
    const g = Object.keys(groups).find(n => lambda.logging_config.log_group === ref('aws_cloudwatch_log_group', n, 'name'))!;
    expect(groups[g].retention_in_days).toBe(90);
  });

  test('its role may write its logs, and stop only this fleet', () => {
    const role = lambda.role.match(/^\$\{aws_iam_role\.([a-z0-9_]+)\.arn\}$/)[1];
    const s = roleStatements(tf, role);
    const stop = s.filter(st => st.actions.includes('appstream:StopFleet'));
    expect(stop).toHaveLength(1);
    expect(stop[0].resources).toEqual([expect.stringContaining(`:fleet/${config.fleet.name}`)]);
    expect(s.some(st => st.actions.includes('logs:PutLogEvents'))).toBe(true);
  });
});
