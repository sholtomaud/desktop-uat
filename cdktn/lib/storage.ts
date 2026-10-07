import { DataAwsIamPolicyDocument } from '@cdktn/provider-aws/lib/data-aws-iam-policy-document';
import { S3Bucket } from '@cdktn/provider-aws/lib/s3-bucket';
import { S3BucketLifecycleConfiguration } from '@cdktn/provider-aws/lib/s3-bucket-lifecycle-configuration';
import { S3BucketPolicy } from '@cdktn/provider-aws/lib/s3-bucket-policy';
import { S3BucketPublicAccessBlock } from '@cdktn/provider-aws/lib/s3-bucket-public-access-block';
import {
  S3BucketServerSideEncryptionConfigurationA,
} from '@cdktn/provider-aws/lib/s3-bucket-server-side-encryption-configuration';
import { Construct } from 'constructs';
import type { Inputs } from './uat-stack';

/** Prefixes: what ec2-uat.sh stages for a run, and what the run reports. */
export const STAGING = 'staging/';
export const RUNS = 'runs/';

/** One private bucket: staged builds and scenarios in, reports and screenshots out. */
export class Storage extends Construct {
  public readonly bucket: S3Bucket;

  constructor(scope: Construct, id: string, props: { inputs: Inputs }) {
    super(scope, id);
    const env = props.inputs.environment.stringValue;

    const bucket = this.bucket = new S3Bucket(this, 'bucket', {
      bucketPrefix: `desktop-uat-${env}-`,
      lifecycle: { preventDestroy: true },
    });

    const publicAccess = new S3BucketPublicAccessBlock(this, 'public_access', {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });

    new S3BucketServerSideEncryptionConfigurationA(this, 'encryption', {
      bucket: bucket.id,
      rule: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
    });

    new S3BucketLifecycleConfiguration(this, 'expiry', {
      bucket: bucket.id,
      rule: [
        { id: 'staging', status: 'Enabled', filter: [{ prefix: STAGING }], expiration: [{ days: props.inputs.stagingRetentionDays.numberValue }] },
        { id: 'runs', status: 'Enabled', filter: [{ prefix: RUNS }], expiration: [{ days: props.inputs.runRetentionDays.numberValue }] },
      ],
    });

    const policy = new DataAwsIamPolicyDocument(this, 'policy_document', {
      statement: [{
        sid: 'DenyInsecureTransport',
        effect: 'Deny',
        actions: ['s3:*'],
        principals: [{ type: '*', identifiers: ['*'] }],
        resources: [bucket.arn, `${bucket.arn}/*`],
        condition: [{ test: 'Bool', variable: 'aws:SecureTransport', values: ['false'] }],
      }],
    });
    // After the public access block: S3 rejects the two changed concurrently.
    new S3BucketPolicy(this, 'policy', { bucket: bucket.id, policy: policy.json, dependsOn: [publicAccess] });
  }
}
