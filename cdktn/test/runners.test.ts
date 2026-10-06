/**
 * Ephemeral GHES runners in the runner tier: infra/lib/runner-stack.ts, as plain
 * Terraform. What the scripts and the harness need of them is in contracts.test.ts.
 */
import { config, only, ref, resources, roleStatements, synth } from './support';

const { tf } = synth();
const [ltName, lt] = only(tf, 'aws_launch_template');
const [, asg] = only(tf, 'aws_autoscaling_group');

test('the launch template enforces IMDSv2 with one hop, and an encrypted gp3 root', () => {
  expect(lt.metadata_options).toMatchObject({ http_tokens: 'required', http_put_response_hop_limit: 1, http_endpoint: 'enabled' });
  expect(lt.block_device_mappings).toEqual([{
    device_name: '/dev/xvda',
    ebs: { encrypted: 'true', volume_size: 50, volume_type: 'gp3' },
  }]);
});

test('it boots the latest Amazon Linux 2023, resolved by EC2 at launch, not at plan', () => {
  expect(lt.image_id).toBe('resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64');
  expect(lt.instance_type).toBe(config.runner.instanceType);
});

test('the group runs the template in the runner tier at the configured size', () => {
  const subnets = resources(tf, 'aws_subnet');
  const runners = Object.keys(subnets).filter(n => subnets[n].tags.Tier === 'runners').map(n => ref('aws_subnet', n, 'id'));
  expect([...asg.vpc_zone_identifier].sort()).toEqual(runners.sort());
  expect(asg).toMatchObject({
    min_size: config.runner.minCapacity,
    max_size: config.runner.maxCapacity,
    health_check_type: 'EC2',
    launch_template: { id: ref('aws_launch_template', ltName, 'id'), version: ref('aws_launch_template', ltName, 'latest_version') },
  });
  expect(asg.instance_refresh).toMatchObject({ strategy: 'Rolling' });
});

test('its group allows HTTPS out and nothing in', () => {
  const [sg] = lt.vpc_security_group_ids;
  const egress = (Object.values(resources(tf, 'aws_vpc_security_group_egress_rule')) as any[]).filter(r => r.security_group_id === sg);
  expect(egress).toEqual([expect.objectContaining({ cidr_ipv4: '0.0.0.0/0', from_port: 443, to_port: 443, ip_protocol: 'tcp' })]);
  expect((Object.values(resources(tf, 'aws_vpc_security_group_ingress_rule')) as any[]).filter(r => r.security_group_id === sg)).toEqual([]);
});

describe('the runner role', () => {
  const runnerRole = Object.keys(resources(tf, 'aws_iam_role')).find(n => n.startsWith('runners_'))!;
  const s = roleStatements(tf, runnerRole);
  const sid = (id: string) => s.find(st => st.sid === id);

  test('is what the instances run as', () => {
    const profiles = resources(tf, 'aws_iam_instance_profile');
    const profile = Object.keys(profiles).find(n => profiles[n].role === ref('aws_iam_role', runnerRole, 'name'))!;
    expect(lt.iam_instance_profile).toEqual({ arn: ref('aws_iam_instance_profile', profile, 'arn') });
  });

  test('has SSM Session Manager for break-glass access', () => {
    const attached = (Object.values(resources(tf, 'aws_iam_role_policy_attachment')) as any[])
      .filter(a => a.role === ref('aws_iam_role', runnerRole, 'name')).map(a => a.policy_arn);
    expect(attached).toEqual([expect.stringMatching(/:policy\/AmazonSSMManagedInstanceCore$/)]);
  });

  test('mints streaming URLs only for its stack and fleet, never *', () => {
    expect(sid('StreamingUrl').actions).toEqual(['appstream:CreateStreamingURL']);
    expect(sid('StreamingUrl').resources).toHaveLength(2);
    expect(sid('StreamingUrl').resources.join(' ')).toContain(`:stack/${config.stack.name}`);
    expect(sid('StreamingUrl').resources.join(' ')).toContain(`:fleet/${config.fleet.name}`);
  });

  test('may call the agent-access MCP endpoint', () => {
    expect(sid('AgentAccessMcp')).toMatchObject({ actions: ['agentaccess-mcp:*'], resources: ['*'] });
  });

  test('can read both token secrets, by name, whatever suffix Secrets Manager gave them', () => {
    const secrets = s.filter(st => st.actions.includes('secretsmanager:GetSecretValue')).flatMap(st => st.resources).join(' ');
    expect(secrets).toContain(`:secret:${config.runner.tokenSecretName}-??????`);
    expect(secrets).toContain(`:secret:${config.artifactory.tokenSecretName}-??????`);
  });
});
