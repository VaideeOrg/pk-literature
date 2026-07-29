variable "environment" {
  type = string
}

variable "service_name" {
  description = "e.g. \"api-catalog\" — used in resource naming."
  type        = string
}

variable "filename" {
  description = "Path to the deployment package zip, built by that service's scripts/package-lambda.sh. Uploaded to var.artifact_bucket and referenced there — never passed to aws_lambda_function directly (see main.tf's aws_s3_object.code comment)."
  type        = string
}

variable "source_code_hash" {
  type = string
}

variable "artifact_bucket" {
  description = "S3 bucket this Lambda's deployment package gets uploaded to before aws_lambda_function references it via s3_bucket/s3_key — see environments/<env>/main.tf's module.lambda_artifacts. Direct/inline filename upload on aws_lambda_function hit a hard provider/SDK limit on large zips (bufio.Scanner: token too long during UpdateFunctionCode); S3-mediated deployment avoids ever embedding the whole zip in that API request."
  type        = string
}

variable "handler" {
  description = "e.g. \"dist/src/lambda.handler\"."
  type        = string
}

variable "runtime" {
  type    = string
  default = "nodejs20.x"
}

variable "memory_size" {
  type    = number
  default = 512
}

variable "timeout" {
  type    = number
  default = 10
}

variable "architectures" {
  description = "x86_64 default matches every existing service. modules/opennext overrides this to [\"arm64\"] for the image-optimization function specifically — @opennextjs/aws builds its sharp native binary for arm64 (AWS's own recommendation for that function, and cheaper besides), and a mismatched architecture here means the deployed binary just can't load."
  type        = list(string)
  default     = ["x86_64"]
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "subnet_ids" {
  description = "Which VPC subnet tier this function lives in — private-isolated for DB-only services, private-nat for services needing internet egress (infrastructure/networking.md). Empty list = not in a VPC at all."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "additional_policy_json" {
  description = "Extra IAM policy JSON (e.g. rds-db:connect) beyond the base execution role. null = no additional policy."
  type        = string
  default     = null
}

variable "attach_additional_policy" {
  description = "Whether to create the additional-permissions role policy. A separate literal flag from additional_policy_json itself — see main.tf's additional resource comment for why: the JSON content can be unknown-until-apply, but this decision can't be if count depends on it."
  type        = bool
  default     = false
}
