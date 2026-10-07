import { DataAwsIamPolicyDocument } from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { IamInstanceProfile } from '@cdktn/provider-aws/lib/iam-instance-profile';
import { IamRole } from '@cdktn/provider-aws/lib/iam-role';
import { IamRolePolicy } from '@cdktn/provider-aws/lib/iam-role-policy';
import { IamRolePolicyAttachment } from '@cdktn/provider-aws/lib/iam-role-policy-attachment';
import { LaunchTemplate } from '@cdktn/provider-aws/lib/launch-template';
import { S3Bucket } from '@cdktn/provider-aws/lib/s3-bucket';
import { SecurityGroup } from '@cdktn/provider-aws/lib/security-group';
import { SsmParameter } from '@cdktn/provider-aws/lib/ssm-parameter';
import { VpcSecurityGroupEgressRule } from '@cdktn/provider-aws/lib/vpc-security-group-egress-rule';
import { VpcSecurityGroupIngressRule } from '@cdktn/provider-aws/lib/vpc-security-group-ingress-rule';
import { Fn, TerraformIterator } from 'cdktn';
import { Construct } from 'constructs';
import { RUNS } from './storage';
import type { Inputs } from './uat-stack';

/** Where Build-UatEc2Image.ps1 installs the scripts. Forward slashes: see hcl.test.ts. */
export const UAT_ROOT = 'C:/Uat';

export interface DesktopProps {
  inputs: Inputs;
  partition: string;
  bucket: S3Bucket;
}

/**
 * The Windows desktop: a launch template for the baked image, its role, its
 * security group, and the settings its boot script reads.
 *
 * At every boot, user data runs Uat-Boot.ps1 (image/ec2/). On the first, it joins
 * the domain and sets up the autologon session the scripted runs use; after
 * that, it lets the tester group RDP in and schedules the TTL shutdown, which
 * terminates the instance.
 */
export class Desktop extends Construct {
  public readonly role: IamRole;
  public readonly launchTemplate: LaunchTemplate;
  public readonly securityGroup: SecurityGroup;
  public readonly config: SsmParameter;

  constructor(scope: Construct, id: string, props: DesktopProps) {
    super(scope, id);
    const { inputs: i, partition, bucket } = props;
    const env = i.environment.stringValue;
    const purpose = `desktop-uat-${env}`;

    // ---------------------------------------------------------------- settings for the boot script
    this.config = new SsmParameter(this, 'config', {
      name: `/desktop-uat/${env}/ec2-config`,
      type: 'String',
      description: 'Settings Uat-Boot.ps1 reads at every boot',
      value: Fn.jsonencode({
        Domain: i.adDomain.stringValue,
        JoinOu: i.adJoinOu.stringValue,
        JoinSecretId: i.adJoinSecretName.stringValue,
        TesterGroup: i.adTesterGroup.stringValue,
        Bucket: bucket.bucket,
        Region: i.region.stringValue,
      }),
    });

    // ---------------------------------------------------------------- role
    const assume = new DataAwsIamPolicyDocument(this, 'assume', {
      statement: [{ actions: ['sts:AssumeRole'], principals: [{ type: 'Service', identifiers: ['ec2.amazonaws.com'] }] }],
    });
    this.role = new IamRole(this, 'role', {
      namePrefix: `${purpose}-desktop-`,
      description: 'Desktop UAT instance: SSM, its settings, the domain join, run reports',
      assumeRolePolicy: assume.json,
    });
    new IamRolePolicyAttachment(this, 'ssm_core', {
      role: this.role.name,
      policyArn: `arn:${partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`,
    });
    // Testers' sessions can reach instance metadata, so this is all the role may do.
    // The join account behind the secret must be able to do no more than join
    // computers to the UAT OU.
    const permissions = new DataAwsIamPolicyDocument(this, 'permissions', {
      statement: [
        { sid: 'Config', actions: ['ssm:GetParameter'], resources: [this.config.arn] },
        {
          sid: 'JoinSecret',
          actions: ['secretsmanager:GetSecretValue'],
          // Created out of band; Secrets Manager appends six random characters to the name.
          resources: [`arn:${partition}:secretsmanager:${i.region.stringValue}:*:secret:${i.adJoinSecretName.stringValue}-??????`],
        },
        { sid: 'RunReports', actions: ['s3:PutObject'], resources: [`${bucket.arn}/${RUNS}*`] },
      ],
    });
    new IamRolePolicy(this, 'policy', { role: this.role.name, policy: permissions.json });
    const profile = new IamInstanceProfile(this, 'profile', { namePrefix: `${purpose}-desktop-`, role: this.role.name });

    // ---------------------------------------------------------------- network
    this.securityGroup = new SecurityGroup(this, 'sg', {
      vpcId: i.vpcId.stringValue,
      namePrefix: `${purpose}-desktop-`,
      description: 'Desktop UAT instances: RDP from corporate networks; HTTPS and AD out',
      lifecycle: { createBeforeDestroy: true },
    });
    const sg = this.securityGroup.id;
    const rdp = TerraformIterator.fromList(i.rdpCidrs.listValue);
    new VpcSecurityGroupIngressRule(this, 'rdp', {
      forEach: rdp,
      securityGroupId: sg,
      description: 'RDP from corporate networks',
      cidrIpv4: rdp.value,
      ipProtocol: 'tcp',
      fromPort: 3389,
      toPort: 3389,
    });
    new VpcSecurityGroupEgressRule(this, 'https', {
      securityGroupId: sg,
      description: 'HTTPS: SSM, S3, the build and scenarios',
      cidrIpv4: '0.0.0.0/0',
      ipProtocol: 'tcp',
      fromPort: 443,
      toPort: 443,
    });
    // A domain member needs DNS, Kerberos, LDAP, SMB, RPC and time from its DCs.
    const ad = TerraformIterator.fromList(i.adCidrs.listValue);
    new VpcSecurityGroupEgressRule(this, 'ad', {
      forEach: ad,
      securityGroupId: sg,
      description: 'Domain controllers',
      cidrIpv4: ad.value,
      ipProtocol: '-1',
    });

    // ---------------------------------------------------------------- launch template
    this.launchTemplate = new LaunchTemplate(this, 'lt', {
      namePrefix: `${purpose}-desktop-`,
      description: 'Desktop UAT: the baked Windows image, run by scripts/ec2-uat.sh',
      // Resolved by EC2 at each launch, so a re-baked image needs no apply.
      imageId: `resolve:ssm:${i.amiParameter.stringValue}`,
      instanceType: i.instanceType.stringValue,
      iamInstanceProfile: { arn: profile.arn },
      vpcSecurityGroupIds: [sg],
      // The boot script's TTL is a shutdown; this turns it into a termination.
      instanceInitiatedShutdownBehavior: 'terminate',
      metadataOptions: {
        httpEndpoint: 'enabled',
        httpTokens: 'required',
        httpPutResponseHopLimit: 1,
        instanceMetadataTags: 'enabled',
      },
      blockDeviceMappings: [{
        deviceName: '/dev/sda1',
        ebs: { volumeSize: i.rootVolumeGb.numberValue, volumeType: 'gp3', encrypted: 'true', deleteOnTermination: 'true' },
      }],
      // EC2Launch v2 runs <persist>ed user data at every boot, not just the first.
      userData: Fn.base64encode(
        `<powershell>& '${UAT_ROOT}/Uat-Boot.ps1' -ConfigParameter '${this.config.name}'</powershell><persist>true</persist>`),
      tagSpecifications: ['instance', 'volume'].map(resourceType => ({ resourceType, tags: { Purpose: purpose } })),
    });
  }
}
