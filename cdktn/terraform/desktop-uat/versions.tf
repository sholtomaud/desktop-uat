terraform {
  required_providers {
    aws = {
      version = "6.66.0"
      source  = "hashicorp/aws"
    }
  }
  backend "local" {
    path = "terraform.tfstate"
  }


}
