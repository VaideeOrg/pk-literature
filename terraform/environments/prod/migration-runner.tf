# One-off DB migration runner (runbooks/deploy.md §4, option 3). Not
# wired to API Gateway — no HTTP trigger, no route. Applying this file
# changes nothing at runtime by itself; only an explicit
#   aws lambda invoke --function-name pk-literature-prod-migration-runner \
#     --cli-binary-format raw-in-base64-out --payload '{}' out.json
# ever runs node-pg-migrate against the real RDS instance. Deployment
# package built by apps/migration-runner/scripts/package-lambda.sh —
# must be run before `terraform apply` touches this file, same as
# every other Lambda service.
#
# Connects with the RDS master credential (Secrets Manager, resolved
# at cold start — never a plain Lambda environment variable, per
# infrastructure/secrets.md), not RDS Proxy IAM auth: the app DB roles
# each service's own migrations grant (catalog_api_readonly, etc.)
# don't exist until api-catalog's migrations create them, so nothing
# but the master user can run migrations from a cold start.
#
# Connects DIRECTLY to RDS, bypassing RDS Proxy entirely — confirmed by
# a real "IAM authentication failed for the role pk_literature_admin"
# error that a stored-password connection through the proxy produces.
# RDS doesn't support IAM database authentication for the master user
# at all, and the proxy's master auth entry deliberately keeps
# iam_auth = REQUIRED (modules/rds-proxy's header comment), so no
# master connection — password or IAM — can ever succeed through the
# proxy. Uses its own dedicated security group
# (security-groups' migration_runner SG) rather than reusing
# lambda_db_sg_id, since this is the one Lambda with direct network
# access to RDS's own port — keeping that grant scoped to exactly this
# function.

locals {
  migration_runner_zip = "${path.module}/../../../apps/migration-runner/dist-lambda.zip"

  # Every stored-password DB role's own secret ARN, keyed by role name
  # — apps/migration-runner/src/sync-role-passwords.ts reads this map
  # (as ROLE_PASSWORD_SECRET_ARNS, JSON-encoded) to keep each role's
  # real Postgres password in sync with Secrets Manager after every
  # migration run. directus_app/medusa_app's passwords were never
  # actually synced anywhere before this either — a real, pre-existing
  # gap only discovered while wiring the other six.
  role_password_secret_arns = merge(
    {
      directus_app = module.secrets_manager.directus_db_password_secret_arn
      medusa_app   = module.secrets_manager.medusa_db_password_secret_arn
    },
    module.secrets_manager.iam_auth_role_secret_arns,
  )
}

data "aws_iam_policy_document" "migration_runner_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = concat([module.secrets_manager.rds_master_secret_arn], values(local.role_password_secret_arns))
  }
}

module "lambda_migration_runner" {
  source = "../../modules/lambda-service"

  environment  = "prod"
  service_name = "migration-runner"

  filename         = local.migration_runner_zip
  source_code_hash = filebase64sha256(local.migration_runner_zip)
  artifact_bucket  = module.lambda_artifacts.bucket_id
  handler          = "dist/src/index.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  # Runs 5 services' migrations sequentially in one invocation —
  # comfortably under this on a small/empty DB, but well above the app
  # Lambdas' 10s since this isn't a per-request path.
  timeout = 120

  # private-isolated tier, same as every other DB-connected Lambda
  # (infrastructure/networking.md) — reaches RDS and Secrets Manager
  # purely intra-VPC, no NAT/internet needed.
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.migration_runner_sg_id]

  environment_variables = {
    RDS_MASTER_SECRET_ARN = module.secrets_manager.rds_master_secret_arn
    # RDS's own endpoint, not RDS Proxy — see file header comment.
    PGHOST                    = module.rds.db_address
    PGPORT                    = tostring(module.rds.db_port)
    PGDATABASE                = "pk_literature"
    ROLE_PASSWORD_SECRET_ARNS = jsonencode(local.role_password_secret_arns)
  }

  additional_policy_json   = data.aws_iam_policy_document.migration_runner_secrets.json
  attach_additional_policy = true
}
