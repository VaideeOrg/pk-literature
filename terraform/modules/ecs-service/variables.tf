variable "environment" {
  type = string
}

variable "service_name" {
  type = string
}

variable "cluster_id" {
  description = "Shared ECS cluster (environments/<env>/ecs-cluster.tf) — not created by this module."
  type        = string
}

variable "image" {
  description = "Full ECR image URI including tag, e.g. <account>.dkr.ecr.<region>.amazonaws.com/pk-literature/directus:1.2.3."
  type        = string
}

variable "container_port" {
  type = number
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "environment_variables" {
  type    = map(string)
  default = {}
}

variable "secrets" {
  description = "Map of container env var name -> Secrets Manager ARN. Resolved by ECS at task start, never passed through Terraform state as plaintext."
  type        = map(string)
  default     = {}
}

variable "subnet_ids" {
  type = list(string)
}

variable "security_group_ids" {
  type = list(string)
}

variable "target_group_arn" {
  type = string
}

variable "health_check_grace_period_seconds" {
  description = "How long ECS ignores a failing ALB health check after a task starts, before deciding it's actually unhealthy and killing it. Defaults to 0 (ECS's own default) - services whose container needs real time to become ready (DB migrations/bootstrap on every boot, not just a fast process start) should set this explicitly, or ECS kills the task mid-boot before it ever has a chance to pass a health check, loops forever between PROVISIONING/DEACTIVATING, and never converges - a real failure mode hit live by ecs_directus."
  type        = number
  default     = 0
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "additional_policy_json" {
  description = "Extra task-role IAM policy JSON (e.g. RDS Proxy connect, S3, EventBridge). null = no additional policy."
  type        = string
  default     = null
}

variable "attach_additional_policy" {
  description = "Whether to create the additional-permissions role policy. A separate literal flag from additional_policy_json itself — see main.tf's task_additional resource comment for why: the JSON content can be unknown-until-apply, but this decision can't be if count depends on it."
  type        = bool
  default     = false
}

variable "enable_execute_command" {
  description = "Enable ECS Exec (aws ecs execute-command) for interactive/diagnostic shell access into a running task. Off by default — it's a debugging capability, not something every service needs. Requires network reachability to the ssmmessages VPC endpoint (or NAT) from wherever the task runs; this module grants the required task-role IAM permissions whenever true, but doesn't provision networking."
  type        = bool
  default     = false
}
