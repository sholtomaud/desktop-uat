# An environment's inputs to cdktn/terraform/desktop-uat. Copy, fill in, and pass
# with -var-file. Every value here is an example.

region              = "ap-southeast-2"
allowed_account_ids = ["111122223333"]
environment         = "uat"

# The existing VPC. Its private subnets must reach SSM, S3, Artifactory and the
# domain controllers.
vpc_id     = "vpc-0123456789abcdef0"
subnet_ids = ["subnet-0123456789abcdef0", "subnet-0fedcba9876543210"]

# Who may RDP in (corporate networks), and where the domain controllers are.
rdp_cidrs = ["10.0.0.0/8"]
ad_cidrs  = ["10.20.0.10/32", "10.20.0.11/32"]

# The domain join. The secret (created out of band) holds {"username","password"}
# of an account that may only create and delete computer objects in ad_join_ou.
ad_domain           = "corp.example.com"
ad_join_ou          = "OU=UAT,OU=Computers,DC=corp,DC=example,DC=com"
ad_join_secret_name = "desktop-uat/ad-join"
ad_tester_group     = "UAT-Testers"

# The read-only Artifactory token the operator stages builds with, {"token"}.
artifactory_token_secret_name = "desktop-uat/artifactory-token"

# Optional; these are the defaults.
# ami_parameter          = "/desktop-uat/ami/windows"
# instance_type          = "m7i.large"
# root_volume_gb         = 100
# staging_retention_days = 14
# run_retention_days     = 180
