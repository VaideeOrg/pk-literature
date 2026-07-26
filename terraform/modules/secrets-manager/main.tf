# Phase 0 scope: the RDS master credential only. This secret exists
# purely for Terraform/migration-runner bootstrap — app services use RDS
# Proxy IAM database authentication, never this stored password (see
# infrastructure/secrets.md). Every other secret (Razorpay, Directus,
# Medusa, ...) is created by the phase that actually needs it.

resource "random_password" "rds_master" {
  length  = 32
  special = true
  # RDS disallows /, @, ", and space in the password itself.
  override_special = "!#$%^&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "rds_master" {
  name        = "/pk-literature/${var.environment}/rds/master"
  description = "RDS PostgreSQL master credential — Terraform/migration bootstrap only, not used by app services (they use RDS Proxy IAM auth)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "rds_master" {
  secret_id = aws_secretsmanager_secret.rds_master.id
  secret_string = jsonencode({
    username = var.rds_master_username
    password = random_password.rds_master.result
  })
}

# ---------------------------------------------------------------------
# RDS Proxy requires a registered Secrets Manager secret for EVERY DB
# username that connects through it — including ones that authenticate
# via IAM, not a password (terraform/modules/rds-proxy's `auth` blocks
# match incoming connections by the secret's own `username` field, then
# iam_auth = REQUIRED on that entry means the password is never
# actually checked). Without an entry, the proxy rejects the connection
# with "This RDS proxy has no credentials for the role <role>" — a real
# error from a live Lambda invocation (apps/api-publisher-import,
# whose publisher_import_writer role had no secret registered at all).
# One secret per IAM-auth DB role created across every migration
# (catalog_api_readonly, feed_api_rw, search_api_readonly,
# commerce_api_rw, identity_api_rw, publisher_import_writer) — the
# password value itself is never read by anything (IAM tokens replace
# it entirely), it exists only so the secret's username field lets RDS
# Proxy recognize the role.
# ---------------------------------------------------------------------

locals {
  iam_auth_db_roles = [
    "catalog_api_readonly",
    "feed_api_rw",
    "search_api_readonly",
    "commerce_api_rw",
    "identity_api_rw",
    "publisher_import_writer",
  ]
}

resource "random_password" "iam_auth_role" {
  for_each = toset(local.iam_auth_db_roles)

  length  = 32
  special = false # unused value — avoid shell/JSON-escaping surprises for no benefit
}

resource "aws_secretsmanager_secret" "iam_auth_role" {
  for_each = toset(local.iam_auth_db_roles)

  name        = "/pk-literature/${var.environment}/rds/iam-auth-roles/${each.value}"
  description = "RDS Proxy auth-registration secret for the ${each.value} DB role — password is unused (this role connects via IAM auth only)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "iam_auth_role" {
  for_each = toset(local.iam_auth_db_roles)

  secret_id = aws_secretsmanager_secret.iam_auth_role[each.value].id
  secret_string = jsonencode({
    username = each.value
    password = random_password.iam_auth_role[each.value].result
  })
}

# ---------------------------------------------------------------------
# Phase 2: Directus. Unlike every other service's DB credential, this
# one is a genuinely stored password injected via ECS task-definition
# secrets — Directus's Knex-based Postgres client has no dynamic IAM
# token refresh support the way apps/api-catalog's Kysely setup does
# (see infrastructure/secrets.md's stored-password exception). KEY and
# SECRET are Directus's own required encryption/signing values (its
# docs: KEY seeds internal project identification, SECRET signs
# auth/session tokens) — both are opaque random values we generate
# once and never need to read back ourselves.
# ---------------------------------------------------------------------

resource "random_password" "directus_db" {
  length  = 32
  special = false # plain env-var-injected password — avoid shell/JSON-escaping surprises
}

resource "aws_secretsmanager_secret" "directus_db" {
  name        = "/pk-literature/${var.environment}/directus/db-password"
  description = "Stored password for the directus_app DB role (migration 20260101000006) — Directus can't do RDS Proxy IAM auth"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "directus_db" {
  secret_id     = aws_secretsmanager_secret.directus_db.id
  secret_string = random_password.directus_db.result
}

resource "random_password" "directus_key" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "directus_key" {
  name        = "/pk-literature/${var.environment}/directus/key"
  description = "Directus KEY — project identification value required at boot"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "directus_key" {
  secret_id     = aws_secretsmanager_secret.directus_key.id
  secret_string = random_password.directus_key.result
}

resource "random_password" "directus_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "directus_secret" {
  name        = "/pk-literature/${var.environment}/directus/secret"
  description = "Directus SECRET — signs auth/session tokens"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "directus_secret" {
  secret_id     = aws_secretsmanager_secret.directus_secret.id
  secret_string = random_password.directus_secret.result
}

resource "random_password" "directus_admin" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "directus_admin" {
  name        = "/pk-literature/${var.environment}/directus/admin-password"
  description = "Directus first-boot admin user password (ADMIN_EMAIL/ADMIN_PASSWORD env vars)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "directus_admin" {
  secret_id     = aws_secretsmanager_secret.directus_admin.id
  secret_string = random_password.directus_admin.result
}

# ---------------------------------------------------------------------
# Phase 6: Razorpay (secrets.md's `/<env>/razorpay/*`, read by both
# lambda-api-commerce and ecs-medusa — the one pair of credentials this
# repo has that Terraform cannot generate itself, since they're issued
# by Razorpay's dashboard, not created by us. The `random_password`
# values below are placeholders only, so `terraform apply` produces a
# valid (if non-functional) secret on day one instead of erroring on a
# missing value; `ignore_changes` on `secret_string` means a human
# pasting the real sandbox/live key over the placeholder via the AWS
# Console or CLI is never clobbered by a subsequent `terraform apply`.
# No real Razorpay credentials exist in this environment (disclosed in
# apps/api-commerce/.env.example and this repo's PR descriptions).
# ---------------------------------------------------------------------

resource "random_password" "razorpay_key_id" {
  length  = 24
  special = false
}

resource "aws_secretsmanager_secret" "razorpay_key_id" {
  name        = "/pk-literature/${var.environment}/razorpay/key-id"
  description = "Razorpay API key ID — placeholder until a human sets the real value (issued by Razorpay's dashboard, not Terraform-generated)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "razorpay_key_id" {
  secret_id     = aws_secretsmanager_secret.razorpay_key_id.id
  secret_string = random_password.razorpay_key_id.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "random_password" "razorpay_key_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "razorpay_key_secret" {
  name        = "/pk-literature/${var.environment}/razorpay/key-secret"
  description = "Razorpay API key secret — placeholder until a human sets the real value"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "razorpay_key_secret" {
  secret_id     = aws_secretsmanager_secret.razorpay_key_secret.id
  secret_string = random_password.razorpay_key_secret.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "random_password" "razorpay_webhook_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "razorpay_webhook_secret" {
  name        = "/pk-literature/${var.environment}/razorpay/webhook-secret"
  description = "Razorpay webhook signing secret — read by lambda-api-commerce's POST /payments/webhook on every call (secrets.md, never cached beyond the Lambda execution environment's lifetime); placeholder until a human sets the real value"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "razorpay_webhook_secret" {
  secret_id     = aws_secretsmanager_secret.razorpay_webhook_secret.id
  secret_string = random_password.razorpay_webhook_secret.result

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# ---------------------------------------------------------------------
# Phase 6: Medusa. Same stored-password rationale as Directus (Medusa's
# Knex-based Postgres client has no dynamic IAM token refresh support
# either) — connects as medusa_app (migration
# 20260401000004_medusa_app_role.sql) with a stored password, not RDS
# Proxy IAM auth.
# ---------------------------------------------------------------------

resource "random_password" "medusa_db" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "medusa_db" {
  name        = "/pk-literature/${var.environment}/medusa/db-password"
  description = "Stored password for the medusa_app DB role (migration 20260401000004) — Medusa can't do RDS Proxy IAM auth, same reasoning as Directus"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "medusa_db" {
  secret_id     = aws_secretsmanager_secret.medusa_db.id
  secret_string = random_password.medusa_db.result
}

resource "random_password" "medusa_jwt_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "medusa_jwt_secret" {
  name        = "/pk-literature/${var.environment}/medusa/jwt-secret"
  description = "Medusa JWT signing secret (admin auth)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "medusa_jwt_secret" {
  secret_id     = aws_secretsmanager_secret.medusa_jwt_secret.id
  secret_string = random_password.medusa_jwt_secret.result
}

resource "random_password" "medusa_cookie_secret" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "medusa_cookie_secret" {
  name        = "/pk-literature/${var.environment}/medusa/cookie-secret"
  description = "Medusa session cookie signing secret (admin auth)"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "medusa_cookie_secret" {
  secret_id     = aws_secretsmanager_secret.medusa_cookie_secret.id
  secret_string = random_password.medusa_cookie_secret.result
}

resource "random_password" "medusa_admin" {
  length           = 32
  special          = true
  override_special = "!#$%^&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "medusa_admin" {
  name        = "/pk-literature/${var.environment}/medusa/admin-password"
  description = "Medusa first-boot admin user password"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "medusa_admin" {
  secret_id     = aws_secretsmanager_secret.medusa_admin.id
  secret_string = random_password.medusa_admin.result
}

# ---------------------------------------------------------------------
# Phase 7: Identity. A single JWT signing secret
# (apps/api-identity/src/auth/jwt.service.ts) — unlike Razorpay, this
# one genuinely can be Terraform-generated (it's not issued by a
# third party), so no `ignore_changes` placeholder pattern is needed
# here.
# ---------------------------------------------------------------------

resource "random_password" "identity_jwt_signing_secret" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "identity_jwt_signing_secret" {
  name        = "/pk-literature/${var.environment}/identity/jwt-signing-secret"
  description = "Signs/verifies apps/api-identity's short-lived access-token JWTs"

  tags = {
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "identity_jwt_signing_secret" {
  secret_id     = aws_secretsmanager_secret.identity_jwt_signing_secret.id
  secret_string = random_password.identity_jwt_signing_secret.result
}
