# RDS Proxy connection pooling — fronts the single RDS instance so
# Lambda's high connection churn doesn't exhaust Postgres's own
# connection limit.
#
# Each `auth` block registers one Secrets Manager secret the proxy will
# accept client connections for — it's not just "which secret the proxy
# uses for its own backend connection" (that part is real too, but any
# registered secret also becomes a valid *client*-facing credential).
# The master secret's block has iam_auth governed by
# var.require_iam_auth (true in every real environment) — since RDS
# doesn't support IAM database authentication for the master user at
# all, iam_auth = REQUIRED on that entry means the master user can
# never connect through this proxy by design, password or IAM; anything
# that genuinely needs the master (migration-runner) connects directly
# to RDS instead, bypassing the proxy entirely.
#
# var.additional_auth_secret_arns registers extra secrets with
# iam_auth = DISABLED unconditionally — Directus/Medusa's own DB-role
# passwords (directus_app/medusa_app), whose Postgres clients (Knex)
# have no dynamic IAM token refresh support, so they connect with a
# stored password instead (infrastructure/secrets.md's documented
# exception). Without an entry here, the proxy has no way to validate
# their password at all — confirmed by a real "IAM authentication
# failed" error from a stored-password connection, which is what
# uncovered that this was never wired up despite being the documented
# intent everywhere else in this codebase.

data "aws_iam_policy_document" "rds_proxy_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_proxy" {
  name               = "pk-literature-${var.environment}-rds-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_proxy_assume_role.json
}

data "aws_iam_policy_document" "rds_proxy_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([var.rds_master_secret_arn], var.additional_auth_secret_arns, var.iam_auth_secret_arns)
  }
}

resource "aws_iam_role_policy" "rds_proxy_secrets" {
  name   = "secrets-access"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.rds_proxy_secrets.json
}

resource "aws_db_proxy" "this" {
  name                   = "pk-literature-${var.environment}"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_subnet_ids         = var.private_isolated_subnet_ids
  vpc_security_group_ids = [var.rds_proxy_sg_id]
  require_tls            = true

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = var.require_iam_auth ? "REQUIRED" : "DISABLED"
    secret_arn  = var.rds_master_secret_arn
  }

  dynamic "auth" {
    for_each = var.additional_auth_secret_arns
    content {
      auth_scheme = "SECRETS"
      iam_auth    = "DISABLED"
      secret_arn  = auth.value
    }
  }

  # Each Lambda service's own IAM-auth DB role (catalog_api_readonly,
  # publisher_import_writer, ...) needs its own registered entry here
  # too, iam_auth = REQUIRED — RDS Proxy identifies which role a
  # connection is for by matching against a registered secret's own
  # username field, regardless of whether that role ultimately
  # authenticates with the secret's password or an IAM token. Without
  # one, the proxy rejects the connection with "This RDS proxy has no
  # credentials for the role <role>" — confirmed by a real error from
  # publisher_import_writer's first live invocation, before this
  # existed for any of these roles.
  dynamic "auth" {
    for_each = var.iam_auth_secret_arns
    content {
      auth_scheme = "SECRETS"
      iam_auth    = "REQUIRED"
      secret_arn  = auth.value
    }
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_db_proxy_default_target_group" "this" {
  db_proxy_name = aws_db_proxy.this.name

  connection_pool_config {
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "this" {
  db_proxy_name          = aws_db_proxy.this.name
  target_group_name      = aws_db_proxy_default_target_group.this.name
  db_instance_identifier = var.db_instance_id
}
