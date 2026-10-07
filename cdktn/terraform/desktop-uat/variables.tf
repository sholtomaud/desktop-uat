variable "region" {
  description = "AWS region, e.g. ap-southeast-2"
  type        = string
}

variable "allowed_account_ids" {
  description = "The only AWS account ids this may be applied to"
  type        = list(string)
}

variable "environment" {
  default     = "uat"
  description = "Environment name, part of every resource name: 2-16 of [a-z0-9-]"
  type        = string
  validation {
    error_message = "environment must be 2-16 characters of [a-z0-9-]."
    condition     = can(regex("^[a-z0-9-]{2,16}$", var.environment))
  }
}

variable "vpc_id" {
  description = "The existing VPC the instances run in"
  type        = string
}

variable "subnet_ids" {
  description = "Private subnets of that VPC; they must reach SSM, S3, Artifactory and the domain controllers"
  type        = list(string)
}

variable "rdp_cidrs" {
  description = "Corporate networks testers RDP in from (TCP 3389)"
  type        = list(string)
}

variable "ad_cidrs" {
  description = "The domain controllers, for the domain join and logons (all traffic)"
  type        = list(string)
}

variable "ad_domain" {
  description = "The AD domain instances join, e.g. corp.example.com"
  type        = string
}

variable "ad_join_ou" {
  description = "OU the computer objects go in, e.g. OU=UAT,OU=Computers,DC=corp,DC=example,DC=com"
  type        = string
}

variable "ad_join_secret_name" {
  description = "Secrets Manager secret (created out of band) with JSON {\"username\",\"password\"} of an account that may only join computers to that OU"
  type        = string
}

variable "ad_tester_group" {
  description = "AD group whose members may RDP in, by name in that domain, e.g. UAT-Testers"
  type        = string
}

variable "ami_parameter" {
  default     = "/desktop-uat/ami/windows"
  description = "SSM parameter holding the baked image id (image/ec2/Build-UatEc2Image.ps1 publishes it)"
  type        = string
}

variable "artifactory_token_secret_name" {
  description = "Secrets Manager secret (created out of band) with JSON {\"token\"}: a read-only Artifactory token the operator stages builds with"
  type        = string
}

variable "instance_type" {
  default     = "m7i.large"
  description = "Instance type for the desktops"
  type        = string
}

variable "root_volume_gb" {
  default     = 100
  description = "Root volume size in GiB"
  type        = number
}

variable "staging_retention_days" {
  default     = 14
  description = "Days staged builds and scenarios are kept"
  type        = number
}

variable "run_retention_days" {
  default     = 180
  description = "Days run reports and screenshots are kept"
  type        = number
}
