terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  backend "s3" {
    # Configured per-environment via -backend-config
    # bucket         = "swiftagent-terraform-state-<account-id>"
    # key            = "<environment>/terraform.tfstate"
    # region         = via -backend-config
    # dynamodb_table = "swiftagent-terraform-locks"
    # encrypt        = true
  }
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "swiftagent"
      ManagedBy = "terraform"
    }
  }
}
