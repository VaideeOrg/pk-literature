# Phase 4's Discovery Feed API (SPEC-05) — public, unauthenticated
# routes (SPEC-16: Discovery reads are public; POST /interest/like is
# extended the same way, no anonymous-session auth exists yet). Added
# in its own file per development/branching.md ("each phase owns its
# own infra"). Deployment package built by
# apps/api-feed/scripts/package-lambda.sh, same convention as
# api-catalog.tf / api-publisher-import.tf.

locals {
  api_feed_zip = "${path.module}/../../../apps/api-feed/dist-lambda.zip"
  # infrastructure/iam.md: lambda-api-feed connects via RDS Proxy IAM
  # auth as feed_api_rw (migration 20260201000002_feed_api_role.sql —
  # apps/api-feed/migrations, since api-feed owns the discovery schema).
  api_feed_db_user = "feed_api_rw"
}

data "aws_iam_policy_document" "api_feed_rds_connect" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_feed_db_user]]
  }
}

module "lambda_api_feed" {
  source = "../../modules/lambda-service"

  environment  = "qa"
  service_name = "api-feed"

  filename         = local.api_feed_zip
  source_code_hash = filebase64sha256(local.api_feed_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  timeout          = 10

  # private-isolated tier: Feed only ever needs RDS Proxy, same as
  # Catalog (infrastructure/networking.md) — no NAT, no internet path.
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_feed_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_feed_db_user]
    AWS_REGION             = data.aws_region.current.name
    CDN_BASE_URL           = "https://cdn.${var.domain_name}"
    # SPEC-05 "Feature Flags" — all default OFF except editorial
    # shelves and New Arrivals, which aren't flag-gated at all.
    FEATURE_TRENDING_SHELF       = "false"
    FEATURE_PERSONALIZED_SHELVES = "false"
  }

  additional_policy_json = data.aws_iam_policy_document.api_feed_rds_connect.json
}

resource "aws_apigatewayv2_integration" "api_feed" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_feed.alias_invoke_arn
  payload_format_version = "2.0"
}

# Public — no authorization_type set (defaults to NONE), unlike
# api-publisher-import.tf's AWS_IAM routes. Matches SPEC-16's
# Discovery = Public.
resource "aws_apigatewayv2_route" "api_feed_get_feed" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/feed"
  target    = "integrations/${aws_apigatewayv2_integration.api_feed.id}"
}

resource "aws_apigatewayv2_route" "api_feed_get_shelf" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/feed/shelf/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.api_feed.id}"
}

resource "aws_apigatewayv2_route" "api_feed_post_like" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/interest/like"
  target    = "integrations/${aws_apigatewayv2_integration.api_feed.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_feed" {
  statement_id  = "AllowAPIGatewayInvokeApiFeed"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_feed.function_name
  qualifier     = module.lambda_api_feed.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
