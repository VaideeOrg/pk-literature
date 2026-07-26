# Phase 1's Lambda + API Gateway wiring, added in its own file per
# development/branching.md ("each phase owns its own infra") — kept out
# of main.tf so later phases' services don't turn it into a dumping
# ground. Deployment package built by
# apps/api-catalog/scripts/package-lambda.sh — must be run before
# `terraform apply` touches this file; see that script's own comments
# and runbooks/deploy.md.
#
# memory_size/timeout deliberately identical to dev/qa — unlike RDS,
# Lambda has no meaningful "idle cost" to size down for lower
# environments; it scales per-invocation regardless. Nothing here
# differs from dev/qa's copy of this file except `environment`.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  api_catalog_zip = "${path.module}/../../../apps/api-catalog/dist-lambda.zip"

  # infrastructure/iam.md: lambda-api-catalog connects via RDS Proxy as
  # the read-only catalog_api_readonly DB role (migration
  # 20260101000005_catalog_readonly_role.sql). Originally RDS Proxy IAM
  # auth; switched to a stored password (terraform/modules/rds-proxy's
  # header comment) after both of RDS Proxy's IAM auth modes were tried
  # against the real deployed stack and abandoned.
  api_catalog_db_user = "catalog_api_readonly"
}

data "aws_iam_policy_document" "api_catalog_rds_connect" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_catalog_db_user]]
  }
}

module "lambda_api_catalog" {
  source = "../../modules/lambda-service"

  environment  = "prod"
  service_name = "api-catalog"

  filename         = local.api_catalog_zip
  source_code_hash = filebase64sha256(local.api_catalog_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  timeout          = 10

  # private-isolated tier: Catalog is read-only and only ever needs RDS
  # Proxy — no NAT, no internet path (infrastructure/networking.md).
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_catalog_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_catalog_db_user]
    CDN_BASE_URL           = "https://cdn.${var.domain_name}"
  }

  additional_policy_json   = data.aws_iam_policy_document.api_catalog_rds_connect.json
  attach_additional_policy = true
}

# --- API Gateway wiring ---
# Catalog's routes (spec-16) don't share one common path prefix, so
# this is one route pair (collection + item) per resource rather than a
# single $default catch-all — $default only supports one target per
# API, and later phases (Feed at /feed, Search at /search, ...) need
# their own.

resource "aws_apigatewayv2_integration" "api_catalog" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_catalog.alias_invoke_arn
  payload_format_version = "2.0"
}

locals {
  api_catalog_resources = ["works", "books", "authors", "publishers", "collections", "themes", "genres"]
}

resource "aws_apigatewayv2_route" "api_catalog_collection" {
  for_each = toset(local.api_catalog_resources)

  api_id    = module.api_gateway.api_id
  route_key = "ANY /v1/${each.value}"
  target    = "integrations/${aws_apigatewayv2_integration.api_catalog.id}"
}

resource "aws_apigatewayv2_route" "api_catalog_item" {
  for_each = toset(local.api_catalog_resources)

  api_id    = module.api_gateway.api_id
  route_key = "ANY /v1/${each.value}/{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_catalog.id}"
}

resource "aws_apigatewayv2_route" "api_catalog_health" {
  api_id    = module.api_gateway.api_id
  route_key = "ANY /v1/health"
  target    = "integrations/${aws_apigatewayv2_integration.api_catalog.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_catalog" {
  statement_id  = "AllowAPIGatewayInvokeApiCatalog"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_catalog.function_name
  qualifier     = module.lambda_api_catalog.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
