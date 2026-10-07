import { DataAwsIamPolicyDocument } from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { IamPolicy } from '@cdktn/provider-aws/lib/iam-policy';
import { SsmParameter } from '@cdktn/provider-aws/lib/ssm-parameter';
import { Fn } from 'cdktn';
import { Construct } from 'constructs';
import { Desktop } from './desktop';
import { Documents } from './documents';
import { RUNS, STAGING, Storage } from './storage';
import type { Inputs } from './uat-stack';

export interface OperatorProps {
  inputs: Inputs;
  partition: string;
  storage: Storage;
  desktop: Desktop;
  documents: Documents;
}

/**
 * What scripts/ec2-uat.sh needs: a discovery parameter naming everything it
 * uses, so it needs no Terraform state, and a managed policy to attach to
 * whatever runs it (the GHES runner role, or an operator's own role): launch
 * from the template, command and terminate only those instances, stage builds,
 * read reports.
 */
export class Operator extends Construct {
  public readonly policy: IamPolicy;
  public readonly discovery: SsmParameter;

  constructor(scope: Construct, id: string, props: OperatorProps) {
    super(scope, id);
    const { inputs: i, partition, storage, desktop, documents } = props;
    const bucket = storage.bucket.arn;
    const purpose = `desktop-uat-${i.environment.stringValue}`;
    this.discovery = new SsmParameter(this, 'discovery', {
      name: `/desktop-uat/${i.environment.stringValue}/ec2-operator`,
      type: 'String',
      description: 'What scripts/ec2-uat.sh launches, commands and stages into',
      value: Fn.jsonencode({
        LaunchTemplateId: desktop.launchTemplate.id,
        SubnetIds: i.subnetIds.listValue,
        Bucket: storage.bucket.bucket,
        RunDocument: documents.run.name,
        LeaveDocument: documents.leave.name,
        Region: i.region.stringValue,
        Purpose: purpose,
      }),
    });

    const tagged = [{ test: 'StringEquals', variable: 'aws:ResourceTag/Purpose', values: [purpose] }];

    const doc = new DataAwsIamPolicyDocument(this, 'permissions', {
      statement: [
        { sid: 'Discover', actions: ['ssm:GetParameter'], resources: [this.discovery.arn] },
        {
          // RunInstances touches many resource types (instance, volume, ENI, subnet,
          // group, image); the launch template is what pins them all down.
          sid: 'RunFromTemplate',
          actions: ['ec2:RunInstances'],
          resources: ['*'],
          condition: [{ test: 'ArnLike', variable: 'ec2:LaunchTemplate', values: [desktop.launchTemplate.arn] }],
        },
        {
          sid: 'TagAtLaunch',
          actions: ['ec2:CreateTags'],
          resources: [`arn:${partition}:ec2:*:*:instance/*`, `arn:${partition}:ec2:*:*:volume/*`],
          condition: [{ test: 'StringEquals', variable: 'ec2:CreateAction', values: ['RunInstances'] }],
        },
        { sid: 'PassDesktopRole', actions: ['iam:PassRole'], resources: [desktop.role.arn] },
        {
          // EC2 resolves the template's resolve:ssm: image with the caller's permissions.
          sid: 'ResolveImage',
          actions: ['ssm:GetParameters'],
          resources: [`arn:${partition}:ssm:${i.region.stringValue}:*:parameter${i.amiParameter.stringValue}`],
        },
        { sid: 'Terminate', actions: ['ec2:TerminateInstances'], resources: ['*'], condition: tagged },
        { sid: 'CommandInstances', actions: ['ssm:SendCommand'], resources: [`arn:${partition}:ec2:*:*:instance/*`], condition: tagged },
        { sid: 'CommandDocuments', actions: ['ssm:SendCommand'], resources: [documents.run.arn, documents.leave.arn] },
        {
          sid: 'Observe',
          actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation', 'ssm:GetCommandInvocation', 'ssm:ListCommandInvocations'],
          resources: ['*'],
        },
        { sid: 'Stage', actions: ['s3:PutObject', 's3:GetObject'], resources: [`${bucket}/${STAGING}*`] },
        {
          // stage-from-artifactory.sh pulls the build with it.
          sid: 'ArtifactoryToken',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:${partition}:secretsmanager:${i.region.stringValue}:*:secret:${i.artifactoryTokenSecretName.stringValue}-??????`],
        },
        { sid: 'ReadReports', actions: ['s3:GetObject'], resources: [`${bucket}/${RUNS}*`] },
        { sid: 'ListBucket', actions: ['s3:ListBucket'], resources: [bucket] },
      ],
    });

    this.policy = new IamPolicy(this, 'policy', {
      name: `${purpose}-operator`,
      description: 'Run desktop UAT on EC2 with scripts/ec2-uat.sh',
      policy: doc.json,
    });
  }
}
