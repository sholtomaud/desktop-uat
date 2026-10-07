output "bucket" {
  value       = aws_s3_bucket.storage_bucket.bucket
  description = "Builds are staged under staging/, reports land under runs/<run id>/"
}

output "launch_template_id" {
  value       = aws_launch_template.desktop_lt.id
  description = "What ec2-uat.sh launches"
}

output "security_group_id" {
  value       = aws_security_group.desktop_sg.id
  description = "The instances' security group"
}

output "config_parameter" {
  value       = aws_ssm_parameter.desktop_config.name
  description = "SSM parameter the boot script reads its settings from"
}

output "discovery_parameter" {
  value       = aws_ssm_parameter.operator_discovery.name
  description = "SSM parameter ec2-uat.sh finds everything else from"
}

output "run_document" {
  value       = aws_ssm_document.run_run.name
  description = "SSM document: one scripted UAT run"
}

output "leave_document" {
  value       = aws_ssm_document.run_leave.name
  description = "SSM document: leave the domain before termination"
}

output "operator_policy_arn" {
  value       = aws_iam_policy.operator_policy.arn
  description = "Attach to whatever runs ec2-uat.sh, e.g. the GHES runner role"
}
