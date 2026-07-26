variable "environment" {
  type = string
}

variable "private_isolated_subnet_ids" {
  type = list(string)
}

variable "rds_proxy_sg_id" {
  type = string
}

variable "db_instance_id" {
  type = string
}

variable "rds_master_secret_arn" {
  type = string
}

variable "require_iam_auth" {
  description = "true = clients authenticating with the master secret must use an IAM auth token, not a stored password (infrastructure/secrets.md's preferred path) — since RDS doesn't support IAM auth for the master user at all, true effectively means the master can never connect through this proxy. Only governs the master secret's own auth entry; see additional_auth_secret_arns for services that always use a stored password regardless of this flag."
  type        = bool
  default     = true
}

variable "additional_auth_secret_arns" {
  description = "Extra Secrets Manager secret ARNs (beyond the master credential) whose DB users connect with a stored password, unconditionally (iam_auth = DISABLED) — e.g. Directus/Medusa's own DB-role secrets, whose Postgres clients have no dynamic IAM token refresh support."
  type        = list(string)
  default     = []
}

variable "iam_auth_secret_arns" {
  description = "Secrets Manager secret ARNs registering DB users that authenticate via IAM (iam_auth = REQUIRED), not a stored password — e.g. every Lambda service's own DB role (catalog_api_readonly, publisher_import_writer, ...). RDS Proxy matches incoming connections to one of these entries by the secret's own username field; without a registered entry here, it rejects the connection outright with \"This RDS proxy has no credentials for the role <role>\" even though the client never actually presents the secret's password — a real error from a live invocation that first surfaced this gap."
  type        = list(string)
  default     = []
}

variable "iam_auth_db_usernames" {
  description = "Plain DB role names (not secret ARNs — e.g. \"publisher_import_writer\", matching iam_auth_secret_arns's roles) that the proxy itself needs rds-db:connect for, under end-to-end IAM auth (default_auth_scheme = IAM_AUTH on aws_db_proxy). End-to-end auth means the proxy — not just the client — presents IAM credentials to the backend Postgres instance for these roles; without this grant on the proxy's own execution role, that backend-side IAM auth fails as a Postgres \"PAM authentication failed\" error, confirmed by a real error from a live invocation after default_auth_scheme was first set to IAM_AUTH."
  type        = list(string)
  default     = []
}
