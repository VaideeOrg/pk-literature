terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.15"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "pk-literature"
      ManagedBy   = "terraform"
      Environment = "prod"
    }
  }
}

# CloudFront certs must live in us-east-1 regardless of the primary
# region — see modules/route53-acm.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      Project     = "pk-literature"
      ManagedBy   = "terraform"
      Environment = "prod"
    }
  }
}
