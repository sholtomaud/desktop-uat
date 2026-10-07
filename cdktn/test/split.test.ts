/**
 * The module is committed as conventional files, not one main.tf: versions,
 * providers, variables, outputs, and one file per component. Terraform reads
 * every .tf in the directory as one module, so the split changes no behaviour.
 */
import { splitHcl } from '../lib/hcl';

const formatted = `terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type = string
}

resource "aws_s3_bucket" "storage_bucket" {
  bucket_prefix = "x-"
}

data "aws_iam_policy_document" "storage_policy_document" {
  statement {
    actions = ["s3:*"]
  }
}

resource "aws_ssm_document" "run_run" {
  content = <<EOF
{
}
EOF
}

locals {
  a = 1
}

output "bucket" {
  value = aws_s3_bucket.storage_bucket.bucket
}
`;

test('blocks go to the file their kind or component belongs in, in their original order', () => {
  expect(splitHcl(formatted)).toEqual({
    'versions.tf': 'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n',
    'providers.tf': 'provider "aws" {\n  region = var.region\n}\n',
    'variables.tf': 'variable "region" {\n  type = string\n}\n',
    'storage.tf': 'resource "aws_s3_bucket" "storage_bucket" {\n  bucket_prefix = "x-"\n}\n\n'
      + 'data "aws_iam_policy_document" "storage_policy_document" {\n  statement {\n    actions = ["s3:*"]\n  }\n}\n',
    'run.tf': 'resource "aws_ssm_document" "run_run" {\n  content = <<EOF\n{\n}\nEOF\n}\n',
    'locals.tf': 'locals {\n  a = 1\n}\n',
    'outputs.tf': 'output "bucket" {\n  value = aws_s3_bucket.storage_bucket.bucket\n}\n',
  });
});

test('a block declared on the stack itself, with no component prefix, goes to main.tf', () => {
  expect(splitHcl('data "aws_partition" "partition" {\n}\n')).toEqual({ 'main.tf': 'data "aws_partition" "partition" {\n}\n' });
});

test('a "}" inside a heredoc does not end the block', () => {
  const files = splitHcl('resource "x" "run_a" {\n  c = <<EOF\n}\n}\nEOF\n}\n');
  expect(files['run.tf']).toBe('resource "x" "run_a" {\n  c = <<EOF\n}\n}\nEOF\n}\n');
});

test('anything outside a block is refused, rather than dropped', () => {
  expect(() => splitHcl('# stray comment\nresource "x" "run_a" {\n}\n')).toThrow(/outside a block/);
});

test('an unterminated block is refused', () => {
  expect(() => splitHcl('resource "x" "run_a" {\n  a = 1\n')).toThrow(/unterminated/);
});
