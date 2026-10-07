provider "aws" {
  allowed_account_ids = var.allowed_account_ids
  region              = var.region
  default_tags {
    tags = {
      Project     = "desktop-uat"
      Environment = "${var.environment}"
    }
  }
}
