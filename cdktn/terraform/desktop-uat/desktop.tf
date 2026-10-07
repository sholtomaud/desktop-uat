resource "aws_ssm_parameter" "desktop_config" {
  description = "Settings Uat-Boot.ps1 reads at every boot"
  name        = "/desktop-uat/${var.environment}/ec2-config"
  type        = "String"
  value       = jsonencode({ "Domain" = var.ad_domain, "JoinOu" = var.ad_join_ou, "JoinSecretId" = var.ad_join_secret_name, "TesterGroup" = var.ad_tester_group, "Bucket" = aws_s3_bucket.storage_bucket.bucket, "Region" = var.region })
}

data "aws_iam_policy_document" "desktop_assume" {
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

resource "aws_iam_role" "desktop_role" {
  assume_role_policy = data.aws_iam_policy_document.desktop_assume.json
  description        = "Desktop UAT instance: SSM, its settings, the domain join, run reports"
  name_prefix        = "desktop-uat-${var.environment}-desktop-"
}

resource "aws_iam_role_policy_attachment" "desktop_ssm_core" {
  policy_arn = "arn:${data.aws_partition.partition.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
  role       = aws_iam_role.desktop_role.name
}

data "aws_iam_policy_document" "desktop_permissions" {
  statement {
    actions = [
      "ssm:GetParameter"
    ]
    resources = [
      "${aws_ssm_parameter.desktop_config.arn}"
    ]
    sid = "Config"
  }
  statement {
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = [
      "arn:${data.aws_partition.partition.partition}:secretsmanager:${var.region}:*:secret:${var.ad_join_secret_name}-??????"
    ]
    sid = "JoinSecret"
  }
  statement {
    actions = [
      "s3:PutObject"
    ]
    resources = [
      "${aws_s3_bucket.storage_bucket.arn}/runs/*"
    ]
    sid = "RunReports"
  }
}

resource "aws_iam_role_policy" "desktop_policy" {
  policy = data.aws_iam_policy_document.desktop_permissions.json
  role   = aws_iam_role.desktop_role.name
}

resource "aws_iam_instance_profile" "desktop_profile" {
  name_prefix = "desktop-uat-${var.environment}-desktop-"
  role        = aws_iam_role.desktop_role.name
}

resource "aws_security_group" "desktop_sg" {
  description = "Desktop UAT instances: RDP from corporate networks; HTTPS and AD out"
  name_prefix = "desktop-uat-${var.environment}-desktop-"
  vpc_id      = var.vpc_id
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_vpc_security_group_ingress_rule" "desktop_rdp" {
  cidr_ipv4         = each.value
  description       = "RDP from corporate networks"
  from_port         = 3389
  ip_protocol       = "tcp"
  security_group_id = aws_security_group.desktop_sg.id
  to_port           = 3389
  for_each          = toset(var.rdp_cidrs)
}

resource "aws_vpc_security_group_egress_rule" "desktop_https" {
  cidr_ipv4         = "0.0.0.0/0"
  description       = "HTTPS: SSM, S3, the build and scenarios"
  from_port         = 443
  ip_protocol       = "tcp"
  security_group_id = aws_security_group.desktop_sg.id
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "desktop_ad" {
  cidr_ipv4         = each.value
  description       = "Domain controllers"
  ip_protocol       = "-1"
  security_group_id = aws_security_group.desktop_sg.id
  for_each          = toset(var.ad_cidrs)
}

resource "aws_launch_template" "desktop_lt" {
  description                          = "Desktop UAT: the baked Windows image, run by scripts/ec2-uat.sh"
  image_id                             = "resolve:ssm:${var.ami_parameter}"
  instance_initiated_shutdown_behavior = "terminate"
  instance_type                        = var.instance_type
  name_prefix                          = "desktop-uat-${var.environment}-desktop-"
  user_data                            = base64encode("<powershell>& 'C:/Uat/Uat-Boot.ps1' -ConfigParameter '${aws_ssm_parameter.desktop_config.name}'</powershell><persist>true</persist>")
  vpc_security_group_ids = [
    "${aws_security_group.desktop_sg.id}"
  ]
  block_device_mappings {
    device_name = "/dev/sda1"
    ebs {
      delete_on_termination = "true"
      encrypted             = "true"
      volume_size           = var.root_volume_gb
      volume_type           = "gp3"
    }
  }
  iam_instance_profile {
    arn = aws_iam_instance_profile.desktop_profile.arn
  }
  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
    http_tokens                 = "required"
    instance_metadata_tags      = "enabled"
  }
  tag_specifications {
    resource_type = "instance"
    tags = {
      Purpose = "desktop-uat-${var.environment}"
    }
  }
  tag_specifications {
    resource_type = "volume"
    tags = {
      Purpose = "desktop-uat-${var.environment}"
    }
  }
}
