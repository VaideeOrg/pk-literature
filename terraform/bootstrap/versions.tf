terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.15"
    }
  }

  # No backend block here on purpose — this layer creates the S3 backend
  # that every other layer uses. It holds its own state locally, held by
  # whoever bootstraps the account. See README.md.
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "pk-literature"
      ManagedBy = "terraform"
      Layer     = "bootstrap"
    }
  }
}
