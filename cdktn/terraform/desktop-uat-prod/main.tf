terraform {
  required_providers {
    aws = {
      version = "6.66.0"
      source  = "hashicorp/aws"
    }
    awscc = {
      version = "1.103.0"
      source  = "hashicorp/awscc"
    }
    archive = {
      version = "2.8.1"
      source  = "hashicorp/archive"
    }
  }
  backend "local" {
    path = "terraform.tfstate"
  }


}

locals {
  runners_user_data = <<EOF
#!/bin/bash
set -euo pipefail
dnf install -y -q git jq tar gzip libicu python3.11 python3.11-pip
id runner >/dev/null 2>&1 || useradd --create-home --shell /bin/bash runner
mkdir -p /opt/actions-runner && chown runner:runner /opt/actions-runner
curl -fsSL -o /opt/actions-runner/runner.tar.gz "https://github.com/actions/runner/releases/download/v2.328.0/actions-runner-linux-x64-2.328.0.tar.gz"
chown runner:runner /opt/actions-runner/runner.tar.gz
cat > /etc/desktop-uat-runner.env <<'ENV'
REGION=ap-southeast-2
SECRET_ID=desktop-uat/ghes-runner-token
TOKEN_ENDPOINT=https://ghes.example.internal/api/v3/orgs/your-org/actions/runners/registration-token
REGISTRATION_URL=https://ghes.example.internal/your-org
LABELS=linux,desktop-uat
UAT_SSM_PREFIX=/desktop-uat/prod
ARTIFACTORY_URL=https://artifactory.example.internal/artifactory
ARTIFACTORY_SECRET_ID=desktop-uat/artifactory-token
ENV
cat > /opt/actions-runner/loop.sh <<'LOOP'
#!/bin/bash
# One ephemeral registration per job; fresh workspace every time.
set -uo pipefail
source /etc/desktop-uat-runner.env
while true; do
  TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text | jq -r .token)
  REG=$(curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$TOKEN_ENDPOINT" | jq -r .token)
  unset TOKEN
  if [ -z "$REG" ] || [ "$REG" = "null" ]; then echo "registration token request failed"; sleep 60; continue; fi
  WORK=$(mktemp -d /opt/actions-runner/run.XXXXXX)
  tar xzf /opt/actions-runner/runner.tar.gz -C "$WORK"
  cd "$WORK"
  ./config.sh --unattended --ephemeral --replace --url "$REGISTRATION_URL" --token "$REG" \
    --labels "$LABELS" --name "uat-$(hostname -s)-$(date +%s)" --work _work || { sleep 30; cd /; rm -rf "$WORK"; continue; }
  ./run.sh
  cd / && rm -rf "$WORK"
done
LOOP
chmod 0755 /opt/actions-runner/loop.sh
cat > /etc/systemd/system/actions-runner.service <<'UNIT'
[Unit]
Description=GHES ephemeral runner loop (desktop UAT)
After=network-online.target
Wants=network-online.target
[Service]
User=runner
Environment=UAT_PYTHON=/usr/bin/python3.11
ExecStart=/opt/actions-runner/loop.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now actions-runner.service
EOF
}

provider "aws" {
  allowed_account_ids = [
    "111122223333"
  ]
  region = "ap-southeast-2"
  default_tags {
    tags = {
      Project     = "desktop-uat"
      Environment = "prod"
    }
  }
}

provider "awscc" {
  region = "ap-southeast-2"
}

provider "archive" {
}
data "aws_partition" "partition" {
}
data "aws_caller_identity" "caller" {
}
resource "aws_vpc" "network_vpc" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = {
    Name = "desktop-uat-prod-vpc"
  }
}
resource "aws_default_security_group" "network_default_sg" {
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_internet_gateway" "network_igw" {
  tags = {
    Name = "desktop-uat-prod-igw"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_subnet" "network_public_0" {
  availability_zone = "ap-southeast-2a"
  cidr_block        = "10.60.0.0/26"
  tags = {
    Name = "desktop-uat-prod-public-ap-southeast-2a"
    Tier = "public"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_public_0_rt" {
  tags = {
    Name = "desktop-uat-prod-public-ap-southeast-2a"
    Tier = "public"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_public_0_assoc" {
  route_table_id = aws_route_table.network_public_0_rt.id
  subnet_id      = aws_subnet.network_public_0.id
}
resource "aws_subnet" "network_public_1" {
  availability_zone = "ap-southeast-2b"
  cidr_block        = "10.60.0.64/26"
  tags = {
    Name = "desktop-uat-prod-public-ap-southeast-2b"
    Tier = "public"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_public_1_rt" {
  tags = {
    Name = "desktop-uat-prod-public-ap-southeast-2b"
    Tier = "public"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_public_1_assoc" {
  route_table_id = aws_route_table.network_public_1_rt.id
  subnet_id      = aws_subnet.network_public_1.id
}
resource "aws_route" "network_public_0_default" {
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.network_igw.id
  route_table_id         = aws_route_table.network_public_0_rt.id
}
resource "aws_route" "network_public_1_default" {
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.network_igw.id
  route_table_id         = aws_route_table.network_public_1_rt.id
}
resource "aws_eip" "network_nat_0_eip" {
  domain = "vpc"
  tags = {
    Name = "desktop-uat-prod-nat-ap-southeast-2a"
  }
}
resource "aws_nat_gateway" "network_nat_0" {
  allocation_id = aws_eip.network_nat_0_eip.allocation_id
  subnet_id     = aws_subnet.network_public_0.id
  tags = {
    Name = "desktop-uat-prod-nat-ap-southeast-2a"
  }
  depends_on = [
    aws_internet_gateway.network_igw,
  ]
}
resource "aws_eip" "network_nat_1_eip" {
  domain = "vpc"
  tags = {
    Name = "desktop-uat-prod-nat-ap-southeast-2b"
  }
}
resource "aws_nat_gateway" "network_nat_1" {
  allocation_id = aws_eip.network_nat_1_eip.allocation_id
  subnet_id     = aws_subnet.network_public_1.id
  tags = {
    Name = "desktop-uat-prod-nat-ap-southeast-2b"
  }
  depends_on = [
    aws_internet_gateway.network_igw,
  ]
}
resource "aws_subnet" "network_runners_0" {
  availability_zone = "ap-southeast-2a"
  cidr_block        = "10.60.1.0/24"
  tags = {
    Name = "desktop-uat-prod-runners-ap-southeast-2a"
    Tier = "runners"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_runners_0_rt" {
  tags = {
    Name = "desktop-uat-prod-runners-ap-southeast-2a"
    Tier = "runners"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_runners_0_assoc" {
  route_table_id = aws_route_table.network_runners_0_rt.id
  subnet_id      = aws_subnet.network_runners_0.id
}
resource "aws_subnet" "network_runners_1" {
  availability_zone = "ap-southeast-2b"
  cidr_block        = "10.60.2.0/24"
  tags = {
    Name = "desktop-uat-prod-runners-ap-southeast-2b"
    Tier = "runners"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_runners_1_rt" {
  tags = {
    Name = "desktop-uat-prod-runners-ap-southeast-2b"
    Tier = "runners"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_runners_1_assoc" {
  route_table_id = aws_route_table.network_runners_1_rt.id
  subnet_id      = aws_subnet.network_runners_1.id
}
resource "aws_route" "network_runners_0_default" {
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.network_nat_0.id
  route_table_id         = aws_route_table.network_runners_0_rt.id
}
resource "aws_route" "network_runners_1_default" {
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.network_nat_1.id
  route_table_id         = aws_route_table.network_runners_1_rt.id
}
resource "aws_subnet" "network_fleet_0" {
  availability_zone = "ap-southeast-2a"
  cidr_block        = "10.60.4.0/22"
  tags = {
    Name = "desktop-uat-prod-fleet-ap-southeast-2a"
    Tier = "fleet"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_fleet_0_rt" {
  tags = {
    Name = "desktop-uat-prod-fleet-ap-southeast-2a"
    Tier = "fleet"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_fleet_0_assoc" {
  route_table_id = aws_route_table.network_fleet_0_rt.id
  subnet_id      = aws_subnet.network_fleet_0.id
}
resource "aws_subnet" "network_fleet_1" {
  availability_zone = "ap-southeast-2b"
  cidr_block        = "10.60.8.0/22"
  tags = {
    Name = "desktop-uat-prod-fleet-ap-southeast-2b"
    Tier = "fleet"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table" "network_fleet_1_rt" {
  tags = {
    Name = "desktop-uat-prod-fleet-ap-southeast-2b"
    Tier = "fleet"
  }
  vpc_id = aws_vpc.network_vpc.id
}
resource "aws_route_table_association" "network_fleet_1_assoc" {
  route_table_id = aws_route_table.network_fleet_1_rt.id
  subnet_id      = aws_subnet.network_fleet_1.id
}
resource "aws_vpc_endpoint" "network_s3" {
  route_table_ids = [
    "${aws_route_table.network_public_0_rt.id}",
    "${aws_route_table.network_public_1_rt.id}",
    "${aws_route_table.network_runners_0_rt.id}",
    "${aws_route_table.network_runners_1_rt.id}",
    "${aws_route_table.network_fleet_0_rt.id}",
    "${aws_route_table.network_fleet_1_rt.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.s3"
  tags = {
    Name = "desktop-uat-prod-s3"
  }
  vpc_endpoint_type = "Gateway"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_security_group" "network_endpoint_sg" {
  description = "Interface endpoints - HTTPS from inside the VPC only"
  name        = "desktop-uat-prod-endpoints"
  vpc_id      = aws_vpc.network_vpc.id
}
resource "aws_vpc_security_group_ingress_rule" "network_endpoint_https" {
  cidr_ipv4         = "10.60.0.0/16"
  description       = "HTTPS from VPC"
  from_port         = 443
  ip_protocol       = "tcp"
  security_group_id = aws_security_group.network_endpoint_sg.id
  to_port           = 443
}
resource "aws_vpc_endpoint" "network_ep_sts" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.sts"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-sts"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_bedrock_runtime" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.bedrock-runtime"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-bedrock-runtime"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_ssm" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.ssm"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-ssm"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_ssmmessages" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.ssmmessages"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-ssmmessages"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_ec2messages" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.ec2messages"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-ec2messages"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_logs" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.logs"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-logs"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_secretsmanager" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.secretsmanager"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-secretsmanager"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_kms" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.kms"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-kms"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_vpc_endpoint" "network_ep_appstream_api" {
  private_dns_enabled = true
  security_group_ids = [
    "${aws_security_group.network_endpoint_sg.id}"
  ]
  service_name = "com.amazonaws.ap-southeast-2.appstream.api"
  subnet_ids = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  tags = {
    Name = "desktop-uat-prod-appstream.api"
  }
  vpc_endpoint_type = "Interface"
  vpc_id            = aws_vpc.network_vpc.id
}
resource "aws_cloudwatch_log_group" "network_flow_logs" {
  name              = "/desktop-uat/desktop-uat-prod-vpc-flow-logs"
  retention_in_days = 365
  lifecycle {
    prevent_destroy = true
  }
}
data "aws_iam_policy_document" "network_flow_logs_assume" {
  statement {
    actions = [
      "sts:AssumeRole"
    ]
    principals {
      identifiers = [
        "vpc-flow-logs.amazonaws.com"
      ]
      type = "Service"
    }
  }
}
resource "aws_iam_role" "network_flow_logs_role" {
  assume_role_policy = data.aws_iam_policy_document.network_flow_logs_assume.json
  name_prefix        = "desktop-uat-flow-logs-"
}
data "aws_iam_policy_document" "network_flow_logs_write" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups",
      "logs:DescribeLogStreams"
    ]
    resources = [
      "${aws_cloudwatch_log_group.network_flow_logs.arn}",
      "${aws_cloudwatch_log_group.network_flow_logs.arn}:*"
    ]
  }
}
resource "aws_iam_role_policy" "network_flow_logs_policy" {
  policy = data.aws_iam_policy_document.network_flow_logs_write.json
  role   = aws_iam_role.network_flow_logs_role.name
}
resource "aws_flow_log" "network_flow_log" {
  iam_role_arn         = aws_iam_role.network_flow_logs_role.arn
  log_destination      = aws_cloudwatch_log_group.network_flow_logs.arn
  log_destination_type = "cloud-watch-logs"
  tags = {
    Name = "desktop-uat-prod-vpc"
  }
  traffic_type = "ALL"
  vpc_id       = aws_vpc.network_vpc.id
}
resource "aws_kms_key" "desktop_key" {
  description         = "Desktop UAT evidence and build artifacts"
  enable_key_rotation = true
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_kms_alias" "desktop_key_alias" {
  name          = "alias/desktop-uat-prod"
  target_key_id = aws_kms_key.desktop_key.key_id
}
resource "aws_s3_bucket" "desktop_access_logs_bucket" {
  bucket_prefix = "desktop-uat-prod-access-logs-"
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_public_access_block" "desktop_access_logs_public_access" {
  block_public_acls       = true
  block_public_policy     = true
  bucket                  = aws_s3_bucket.desktop_access_logs_bucket.id
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "desktop_access_logs_encryption" {
  bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "desktop_access_logs_expiry" {
  bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  rule {
    id     = "expire"
    status = "Enabled"
    expiration {
      days = 365
    }
    filter {

    }
  }
}
data "aws_iam_policy_document" "desktop_access_logs_policy_document" {
  statement {
    actions = [
      "s3:*"
    ]
    effect = "Deny"
    resources = [
      "${aws_s3_bucket.desktop_access_logs_bucket.arn}",
      "${aws_s3_bucket.desktop_access_logs_bucket.arn}/*"
    ]
    sid = "DenyInsecureTransport"
    condition {
      test = "Bool"
      values = [
        "false"
      ]
      variable = "aws:SecureTransport"
    }
    principals {
      identifiers = [
        "*"
      ]
      type = "*"
    }
  }
  statement {
    actions = [
      "s3:PutObject"
    ]
    resources = [
      "${aws_s3_bucket.desktop_access_logs_bucket.arn}/*"
    ]
    sid = "S3ServerAccessLogs"
    condition {
      test = "StringEquals"
      values = [
        "${data.aws_caller_identity.caller.account_id}"
      ]
      variable = "aws:SourceAccount"
    }
    principals {
      identifiers = [
        "logging.s3.amazonaws.com"
      ]
      type = "Service"
    }
  }
}
resource "aws_s3_bucket_policy" "desktop_access_logs_policy" {
  bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  policy = data.aws_iam_policy_document.desktop_access_logs_policy_document.json
  depends_on = [
    aws_s3_bucket_public_access_block.desktop_access_logs_public_access,
  ]
}
resource "aws_s3_bucket_ownership_controls" "desktop_access_logs_ownership" {
  bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}
resource "aws_s3_bucket" "desktop_evidence_bucket" {
  bucket_prefix = "desktop-uat-prod-evidence-"
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_public_access_block" "desktop_evidence_public_access" {
  block_public_acls       = true
  block_public_policy     = true
  bucket                  = aws_s3_bucket.desktop_evidence_bucket.id
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "desktop_evidence_encryption" {
  bucket = aws_s3_bucket.desktop_evidence_bucket.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.desktop_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "desktop_evidence_expiry" {
  bucket = aws_s3_bucket.desktop_evidence_bucket.id
  rule {
    id     = "expire"
    status = "Enabled"
    expiration {
      days = 180
    }
    filter {

    }
  }
}
resource "aws_s3_bucket_logging" "desktop_evidence_logging" {
  bucket        = aws_s3_bucket.desktop_evidence_bucket.id
  target_bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  target_prefix = "evidence/"
}
data "aws_iam_policy_document" "desktop_evidence_policy_document" {
  statement {
    actions = [
      "s3:*"
    ]
    effect = "Deny"
    resources = [
      "${aws_s3_bucket.desktop_evidence_bucket.arn}",
      "${aws_s3_bucket.desktop_evidence_bucket.arn}/*"
    ]
    sid = "DenyInsecureTransport"
    condition {
      test = "Bool"
      values = [
        "false"
      ]
      variable = "aws:SecureTransport"
    }
    principals {
      identifiers = [
        "*"
      ]
      type = "*"
    }
  }
  statement {
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation"
    ]
    resources = [
      "${aws_s3_bucket.desktop_evidence_bucket.arn}"
    ]
    sid = "AppStreamAgentAccessList"
    condition {
      test = "StringEquals"
      values = [
        "${data.aws_caller_identity.caller.account_id}"
      ]
      variable = "aws:SourceAccount"
    }
    principals {
      identifiers = [
        "appstream.amazonaws.com"
      ]
      type = "Service"
    }
  }
}
resource "aws_s3_bucket_policy" "desktop_evidence_policy" {
  bucket = aws_s3_bucket.desktop_evidence_bucket.id
  policy = data.aws_iam_policy_document.desktop_evidence_policy_document.json
  depends_on = [
    aws_s3_bucket_public_access_block.desktop_evidence_public_access,
  ]
}
resource "aws_s3_bucket" "desktop_builds_bucket" {
  bucket_prefix = "desktop-uat-prod-builds-"
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_public_access_block" "desktop_builds_public_access" {
  block_public_acls       = true
  block_public_policy     = true
  bucket                  = aws_s3_bucket.desktop_builds_bucket.id
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_server_side_encryption_configuration" "desktop_builds_encryption" {
  bucket = aws_s3_bucket.desktop_builds_bucket.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.desktop_key.arn
      sse_algorithm     = "aws:kms"
    }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "desktop_builds_expiry" {
  bucket = aws_s3_bucket.desktop_builds_bucket.id
  rule {
    id     = "expire"
    status = "Enabled"
    expiration {
      days = 30
    }
    filter {

    }
  }
}
resource "aws_s3_bucket_logging" "desktop_builds_logging" {
  bucket        = aws_s3_bucket.desktop_builds_bucket.id
  target_bucket = aws_s3_bucket.desktop_access_logs_bucket.id
  target_prefix = "builds/"
}
data "aws_iam_policy_document" "desktop_builds_policy_document" {
  statement {
    actions = [
      "s3:*"
    ]
    effect = "Deny"
    resources = [
      "${aws_s3_bucket.desktop_builds_bucket.arn}",
      "${aws_s3_bucket.desktop_builds_bucket.arn}/*"
    ]
    sid = "DenyInsecureTransport"
    condition {
      test = "Bool"
      values = [
        "false"
      ]
      variable = "aws:SecureTransport"
    }
    principals {
      identifiers = [
        "*"
      ]
      type = "*"
    }
  }
  statement {
    actions = [
      "s3:GetObject"
    ]
    effect = "Deny"
    resources = [
      "${aws_s3_bucket.desktop_builds_bucket.arn}/*"
    ]
    sid = "DenyGetOutsideVpc"
    condition {
      test = "StringNotEquals"
      values = [
        "${aws_vpc_endpoint.network_s3.id}"
      ]
      variable = "aws:SourceVpce"
    }
    principals {
      identifiers = [
        "*"
      ]
      type = "*"
    }
  }
}
resource "aws_s3_bucket_policy" "desktop_builds_policy" {
  bucket = aws_s3_bucket.desktop_builds_bucket.id
  policy = data.aws_iam_policy_document.desktop_builds_policy_document.json
  depends_on = [
    aws_s3_bucket_public_access_block.desktop_builds_public_access,
  ]
}
resource "aws_security_group" "desktop_fleet_sg" {
  description = "UAT streaming desktops - isolated subnets, S3 gateway endpoint only"
  name        = "desktop-uat-prod-fleet"
  vpc_id      = aws_vpc.network_vpc.id
}
resource "aws_vpc_security_group_egress_rule" "desktop_fleet_https" {
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS to S3 via gateway endpoint"
  from_port         = 443
  ip_protocol       = "tcp"
  security_group_id = aws_security_group.desktop_fleet_sg.id
  to_port           = 443
}
resource "aws_appstream_fleet" "desktop_fleet" {
  description                        = "Agentic UAT/beta testing desktops"
  disconnect_timeout_in_seconds      = 60
  display_name                       = "Desktop UAT (prod)"
  enable_default_internet_access     = false
  fleet_type                         = "ON_DEMAND"
  idle_disconnect_timeout_in_seconds = 900
  image_name                         = "desktop-uat-base-2026-10-01"
  instance_type                      = "stream.standard.large"
  max_user_duration_in_seconds       = 7200
  name                               = "desktop-uat-fleet"
  stream_view                        = "DESKTOP"
  compute_capacity {
    desired_instances = 2
  }
  vpc_config {
    security_group_ids = [
      "${aws_security_group.desktop_fleet_sg.id}"
    ]
    subnet_ids = [
      "${aws_subnet.network_fleet_0.id}",
      "${aws_subnet.network_fleet_1.id}"
    ]
  }
}
resource "awscc_appstream_stack" "desktop_agent_stack" {
  agent_access_config = {
    s3_bucket_arn              = "${aws_s3_bucket.desktop_evidence_bucket.arn}"
    screen_image_format        = "PNG"
    screen_resolution          = "W_1280xH_720"
    screenshots_upload_enabled = true
    settings = [
      {
        agent_action = "COMPUTER_VISION"
        permission   = "ENABLED"
      },
      {
        agent_action = "COMPUTER_INPUT"
        permission   = "ENABLED"
      },
      {
        agent_action = "FORWARD_MCP_TOOLS"
        permission   = "ENABLED"
      },
    ]
    user_control_mode = "VIEW_STOP"
  }
  description  = "Agent access stack for agentic UAT. Not for human users."
  display_name = "Desktop UAT agents (prod)"
  name         = "desktop-uat-agent-stack"
}
resource "aws_appstream_fleet_stack_association" "desktop_association" {
  fleet_name = aws_appstream_fleet.desktop_fleet.name
  stack_name = awscc_appstream_stack.desktop_agent_stack.name
}
resource "aws_ssm_parameter" "desktop_lease" {
  description = "Epoch seconds until which a workflow holds the UAT fleet"
  name        = "/desktop-uat/prod/fleet-lease"
  type        = "String"
  value       = "0"
  lifecycle {
    ignore_changes = [
      value,
    ]
  }
}
resource "aws_cloudwatch_log_group" "desktop_janitor_logs" {
  name              = "/aws/lambda/desktop-uat-prod-fleet-janitor"
  retention_in_days = 90
}
data "aws_iam_policy_document" "desktop_janitor_assume" {
  statement {
    actions = [
      "sts:AssumeRole"
    ]
    principals {
      identifiers = [
        "lambda.amazonaws.com"
      ]
      type = "Service"
    }
  }
}
resource "aws_iam_role" "desktop_janitor_role" {
  assume_role_policy = data.aws_iam_policy_document.desktop_janitor_assume.json
  name_prefix        = "desktop-uat-janitor-"
}
data "aws_iam_policy_document" "desktop_janitor_permissions" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [
      "${aws_cloudwatch_log_group.desktop_janitor_logs.arn}:*"
    ]
    sid = "Logs"
  }
  statement {
    actions = [
      "appstream:DescribeFleets",
      "appstream:DescribeSessions"
    ]
    resources = [
      "*"
    ]
    sid = "Describe"
  }
  statement {
    actions = [
      "appstream:StopFleet"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:appstream:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:fleet/desktop-uat-fleet"
    ]
    sid = "StopFleet"
  }
  statement {
    actions = [
      "ssm:GetParameter"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ssm:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:parameter/desktop-uat/prod/fleet-lease"
    ]
    sid = "Lease"
  }
}
resource "aws_iam_role_policy" "desktop_janitor_policy" {
  policy = data.aws_iam_policy_document.desktop_janitor_permissions.json
  role   = aws_iam_role.desktop_janitor_role.name
}
data "archive_file" "desktop_janitor_code" {
  output_path = "${path.module}/.build/fleet-janitor.zip"
  type        = "zip"
  source {
    content  = <<EOF
const { AppStreamClient, DescribeFleetsCommand, DescribeSessionsCommand, StopFleetCommand } = require('@aws-sdk/client-appstream');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const as = new AppStreamClient({});
const ssm = new SSMClient({});
exports.handler = async () => {
  const { FLEET_NAME, STACK_NAME, LEASE_PARAM } = process.env;
  const fleet = (await as.send(new DescribeFleetsCommand({ Names: [FLEET_NAME] }))).Fleets?.[0];
  if (!fleet || fleet.State !== 'RUNNING') return { action: 'none', state: fleet?.State };
  const lease = Number((await ssm.send(new GetParameterCommand({ Name: LEASE_PARAM }))).Parameter?.Value ?? '0');
  const now = Math.floor(Date.now() / 1000);
  if (lease > now) return { action: 'none', reason: 'lease held', leaseExpiresIn: lease - now };
  const sessions = await as.send(new DescribeSessionsCommand({ StackName: STACK_NAME, FleetName: FLEET_NAME }));
  if ((sessions.Sessions ?? []).length > 0) return { action: 'none', reason: 'active sessions' };
  await as.send(new StopFleetCommand({ Name: FLEET_NAME }));
  console.log(JSON.stringify({ action: 'stopped', fleet: FLEET_NAME }));
  return { action: 'stopped' };
};
EOF
    filename = "index.js"
  }
}
resource "aws_lambda_function" "desktop_janitor" {
  description      = "Stops the UAT fleet when idle and unleased (cost safety net)"
  filename         = data.archive_file.desktop_janitor_code.output_path
  function_name    = "desktop-uat-prod-fleet-janitor"
  handler          = "index.handler"
  role             = aws_iam_role.desktop_janitor_role.arn
  runtime          = "nodejs24.x"
  source_code_hash = data.archive_file.desktop_janitor_code.output_base64sha256
  timeout          = 60
  environment {
    variables = {
      FLEET_NAME  = "desktop-uat-fleet"
      STACK_NAME  = "desktop-uat-agent-stack"
      LEASE_PARAM = "/desktop-uat/prod/fleet-lease"
    }
  }
  logging_config {
    log_format = "Text"
    log_group  = aws_cloudwatch_log_group.desktop_janitor_logs.name
  }
}
resource "aws_cloudwatch_event_rule" "desktop_janitor_schedule" {
  name                = "desktop-uat-prod-fleet-janitor-schedule"
  schedule_expression = "rate(15 minutes)"
}
resource "aws_cloudwatch_event_target" "desktop_janitor_target" {
  arn  = aws_lambda_function.desktop_janitor.arn
  rule = aws_cloudwatch_event_rule.desktop_janitor_schedule.name
}
resource "aws_lambda_permission" "desktop_janitor_invoke" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.desktop_janitor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.desktop_janitor_schedule.arn
}
resource "aws_ssm_parameter" "desktop_param_region" {
  name  = "/desktop-uat/prod/region"
  type  = "String"
  value = "ap-southeast-2"
}
resource "aws_ssm_parameter" "desktop_param_fleet_name" {
  name  = "/desktop-uat/prod/fleet-name"
  type  = "String"
  value = "desktop-uat-fleet"
}
resource "aws_ssm_parameter" "desktop_param_stack_name" {
  name  = "/desktop-uat/prod/stack-name"
  type  = "String"
  value = "desktop-uat-agent-stack"
}
resource "aws_ssm_parameter" "desktop_param_evidence_bucket" {
  name  = "/desktop-uat/prod/evidence-bucket"
  type  = "String"
  value = aws_s3_bucket.desktop_evidence_bucket.bucket
}
resource "aws_ssm_parameter" "desktop_param_builds_bucket" {
  name  = "/desktop-uat/prod/builds-bucket"
  type  = "String"
  value = aws_s3_bucket.desktop_builds_bucket.bucket
}
resource "aws_ssm_parameter" "desktop_param_mcp_endpoint" {
  name  = "/desktop-uat/prod/mcp-endpoint"
  type  = "String"
  value = "https://agentaccess-mcp.ap-southeast-2.api.aws/mcp"
}
resource "aws_ssm_parameter" "desktop_param_bedrock_model_id" {
  name  = "/desktop-uat/prod/bedrock-model-id"
  type  = "String"
  value = "global.anthropic.claude-sonnet-4-6"
}
resource "aws_ssm_parameter" "desktop_param_max_concurrent_sessions" {
  name  = "/desktop-uat/prod/max-concurrent-sessions"
  type  = "String"
  value = "2"
}
data "aws_iam_policy_document" "runners_assume" {
  statement {
    actions = [
      "sts:AssumeRole"
    ]
    principals {
      identifiers = [
        "ec2.amazonaws.com"
      ]
      type = "Service"
    }
  }
}
resource "aws_iam_role" "runners_role" {
  assume_role_policy = data.aws_iam_policy_document.runners_assume.json
  description        = "GHES desktop-UAT runner: drives WorkSpaces agent sessions"
  name_prefix        = "desktop-uat-runner-"
}
resource "aws_iam_role_policy_attachment" "runners_ssm_core" {
  policy_arn = "arn:${data.aws_partition.partition.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
  role       = aws_iam_role.runners_role.name
}
data "aws_iam_policy_document" "runners_permissions" {
  statement {
    actions = [
      "appstream:CreateStreamingURL"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:appstream:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:stack/desktop-uat-agent-stack",
      "arn:${data.aws_partition.partition.partition}:appstream:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:fleet/desktop-uat-fleet"
    ]
    sid = "StreamingUrl"
  }
  statement {
    actions = [
      "appstream:StartFleet",
      "appstream:StopFleet"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:appstream:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:fleet/desktop-uat-fleet"
    ]
    sid = "FleetLifecycle"
  }
  statement {
    actions = [
      "appstream:DescribeFleets",
      "appstream:DescribeStacks",
      "appstream:DescribeSessions"
    ]
    resources = [
      "*"
    ]
    sid = "Describe"
  }
  statement {
    actions = [
      "agentaccess-mcp:*"
    ]
    resources = [
      "*"
    ]
    sid = "AgentAccessMcp"
  }
  statement {
    actions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:bedrock:*::foundation-model/anthropic.*",
      "arn:${data.aws_partition.partition.partition}:bedrock:*:${data.aws_caller_identity.caller.account_id}:inference-profile/*"
    ]
    sid = "Bedrock"
  }
  statement {
    actions = [
      "s3:GetObject*",
      "s3:GetBucket*",
      "s3:List*",
      "s3:DeleteObject*",
      "s3:PutObject",
      "s3:PutObjectLegalHold",
      "s3:PutObjectRetention",
      "s3:PutObjectTagging",
      "s3:PutObjectVersionTagging",
      "s3:Abort*"
    ]
    resources = [
      "${aws_s3_bucket.desktop_evidence_bucket.arn}",
      "${aws_s3_bucket.desktop_evidence_bucket.arn}/*",
      "${aws_s3_bucket.desktop_builds_bucket.arn}",
      "${aws_s3_bucket.desktop_builds_bucket.arn}/*"
    ]
    sid = "Buckets"
  }
  statement {
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:Encrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*"
    ]
    resources = [
      "${aws_kms_key.desktop_key.arn}"
    ]
    sid = "Key"
  }
  statement {
    actions = [
      "ssm:GetParameter",
      "ssm:GetParameters",
      "ssm:GetParametersByPath"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ssm:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:parameter/desktop-uat/prod/*"
    ]
    sid = "SsmRead"
  }
  statement {
    actions = [
      "ssm:PutParameter",
      "ssm:DeleteParameter"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ssm:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:parameter/desktop-uat/prod/fleet-lease",
      "arn:${data.aws_partition.partition.partition}:ssm:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:parameter/desktop-uat/prod/observe/*"
    ]
    sid = "SsmWrite"
  }
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:secretsmanager:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:secret:desktop-uat/ghes-runner-token-??????",
      "arn:${data.aws_partition.partition.partition}:secretsmanager:ap-southeast-2:${data.aws_caller_identity.caller.account_id}:secret:desktop-uat/artifactory-token-??????"
    ]
    sid = "Secrets"
  }
}
resource "aws_iam_role_policy" "runners_policy" {
  policy = data.aws_iam_policy_document.runners_permissions.json
  role   = aws_iam_role.runners_role.name
}
resource "aws_iam_instance_profile" "runners_profile" {
  name_prefix = "desktop-uat-runner-"
  role        = aws_iam_role.runners_role.name
}
resource "aws_security_group" "runners_sg" {
  description = "GHES runners - HTTPS egress only, no ingress"
  name        = "desktop-uat-prod-runners"
  vpc_id      = aws_vpc.network_vpc.id
}
resource "aws_vpc_security_group_egress_rule" "runners_https" {
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS: MCP endpoint, GHES, Artifactory, package mirrors"
  from_port         = 443
  ip_protocol       = "tcp"
  security_group_id = aws_security_group.runners_sg.id
  to_port           = 443
}
resource "aws_launch_template" "runners_lt" {
  image_id      = "resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
  instance_type = "m7i.large"
  name_prefix   = "desktop-uat-prod-runner-"
  user_data     = base64encode(local.runners_user_data)
  vpc_security_group_ids = [
    "${aws_security_group.runners_sg.id}"
  ]
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      encrypted   = "true"
      volume_size = 50
      volume_type = "gp3"
    }
  }
  iam_instance_profile {
    arn = aws_iam_instance_profile.runners_profile.arn
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
  }
  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "desktop-uat-prod-runner"
    }
  }
}
resource "aws_autoscaling_group" "runners_asg" {
  health_check_type = "EC2"
  max_size          = 2
  min_size          = 1
  name_prefix       = "desktop-uat-prod-runners-"
  vpc_zone_identifier = [
    "${aws_subnet.network_runners_0.id}",
    "${aws_subnet.network_runners_1.id}"
  ]
  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
    }
  }
  launch_template {
    id      = aws_launch_template.runners_lt.id
    version = aws_launch_template.runners_lt.latest_version
  }
}

output "vpc_id" {
  value = aws_vpc.network_vpc.id
}

output "fleet_name" {
  value = "desktop-uat-fleet"
}

output "stack_name" {
  value = "desktop-uat-agent-stack"
}

output "evidence_bucket" {
  value = aws_s3_bucket.desktop_evidence_bucket.bucket
}

output "builds_bucket" {
  value = aws_s3_bucket.desktop_builds_bucket.bucket
}