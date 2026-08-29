variable "aws_region" {
  description = "Primary AWS region for the account."
  type        = string
  default     = "ap-southeast-1"
}

variable "state_bucket_name" {
  description = "Globally-unique S3 bucket name for Terraform remote state. Must be chosen before first apply and never changed."
  type        = string
  default     = "pk-literature-terraform-state"
}

variable "state_lock_table_name" {
  description = "DynamoDB table name for Terraform state locking."
  type        = string
  default     = "pk-literature-terraform-locks"
}

variable "github_org" {
  description = "GitHub org/user that owns the repo — scopes the OIDC trust policy."
  type        = string
  # Repo moved from vaidee/pk-literature to VaideeOrg/pk-literature -
  # this was never updated to match, so the OIDC trust policy's sub
  # condition (oidc.tf, gha-publisher-import.tf) only ever matched
  # "repo:vaidee/pk-literature:..." tokens. Every GitHub Actions
  # workflow that assumes a gha-deploy-<env> or
  # gha-publisher-import-<env> role has been failing
  # AssumeRoleWithWebIdentity since the move, not just this specific
  # apply - confirmed against a real failing terraform plan run.
  default = "VaideeOrg"
}

variable "github_repo" {
  description = "GitHub repo name — scopes the OIDC trust policy."
  type        = string
  default     = "pk-literature"
}

variable "environments" {
  description = "Environments to create deploy roles for. Each gets its own gha-deploy-<env> role."
  type        = list(string)
  default     = ["dev", "qa", "prod"]
}
