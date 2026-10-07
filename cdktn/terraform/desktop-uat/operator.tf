resource "aws_ssm_parameter" "operator_discovery" {
  description = "What scripts/ec2-uat.sh launches, commands and stages into"
  name        = "/desktop-uat/${var.environment}/ec2-operator"
  type        = "String"
  value       = jsonencode({ "LaunchTemplateId" = aws_launch_template.desktop_lt.id, "SubnetIds" = var.subnet_ids, "Bucket" = aws_s3_bucket.storage_bucket.bucket, "RunDocument" = aws_ssm_document.run_run.name, "LeaveDocument" = aws_ssm_document.run_leave.name, "Region" = var.region })
}

data "aws_iam_policy_document" "operator_permissions" {
  statement {
    actions = [
      "ssm:GetParameter"
    ]
    resources = [
      "${aws_ssm_parameter.operator_discovery.arn}"
    ]
    sid = "Discover"
  }
  statement {
    actions = [
      "ec2:RunInstances"
    ]
    resources = [
      "*"
    ]
    sid = "RunFromTemplate"
    condition {
      test = "ArnLike"
      values = [
        "${aws_launch_template.desktop_lt.arn}"
      ]
      variable = "ec2:LaunchTemplate"
    }
  }
  statement {
    actions = [
      "ec2:CreateTags"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ec2:*:*:instance/*",
      "arn:${data.aws_partition.partition.partition}:ec2:*:*:volume/*"
    ]
    sid = "TagAtLaunch"
    condition {
      test = "StringEquals"
      values = [
        "RunInstances"
      ]
      variable = "ec2:CreateAction"
    }
  }
  statement {
    actions = [
      "iam:PassRole"
    ]
    resources = [
      "${aws_iam_role.desktop_role.arn}"
    ]
    sid = "PassDesktopRole"
  }
  statement {
    actions = [
      "ssm:GetParameters"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ssm:${var.region}:*:parameter${var.ami_parameter}"
    ]
    sid = "ResolveImage"
  }
  statement {
    actions = [
      "ec2:TerminateInstances"
    ]
    resources = [
      "*"
    ]
    sid = "Terminate"
    condition {
      test = "StringEquals"
      values = [
        "desktop-uat-${var.environment}"
      ]
      variable = "aws:ResourceTag/Purpose"
    }
  }
  statement {
    actions = [
      "ssm:SendCommand"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:ec2:*:*:instance/*"
    ]
    sid = "CommandInstances"
    condition {
      test = "StringEquals"
      values = [
        "desktop-uat-${var.environment}"
      ]
      variable = "aws:ResourceTag/Purpose"
    }
  }
  statement {
    actions = [
      "ssm:SendCommand"
    ]
    resources = [
      "${aws_ssm_document.run_run.arn}",
      "${aws_ssm_document.run_leave.arn}"
    ]
    sid = "CommandDocuments"
  }
  statement {
    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:GetCommandInvocation",
      "ssm:ListCommandInvocations"
    ]
    resources = [
      "*"
    ]
    sid = "Observe"
  }
  statement {
    actions = [
      "s3:PutObject",
      "s3:GetObject"
    ]
    resources = [
      "${aws_s3_bucket.storage_bucket.arn}/staging/*"
    ]
    sid = "Stage"
  }
  statement {
    actions = [
      "s3:GetObject"
    ]
    resources = [
      "${aws_s3_bucket.storage_bucket.arn}/runs/*"
    ]
    sid = "ReadReports"
  }
  statement {
    actions = [
      "s3:ListBucket"
    ]
    resources = [
      "${aws_s3_bucket.storage_bucket.arn}"
    ]
    sid = "ListBucket"
  }
}

resource "aws_iam_policy" "operator_policy" {
  description = "Run desktop UAT on EC2 with scripts/ec2-uat.sh"
  name        = "desktop-uat-${var.environment}-operator"
  policy      = data.aws_iam_policy_document.operator_permissions.json
}
