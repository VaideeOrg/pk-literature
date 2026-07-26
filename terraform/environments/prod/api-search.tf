# Phase 5's Search & Discovery API (SPEC-08) — public, unauthenticated
# routes (SPEC-16: Discovery reads are public; search has no writes at
# all, SPEC-08 §3 Non Goals). Added in its own file per
# development/branching.md ("each phase owns its own infra"). Deployment
# package built by apps/api-search/scripts/package-lambda.sh, same
# convention as api-catalog.tf / api-feed.tf.

locals {
  api_search_zip = "${path.module}/../../../apps/api-search/dist-lambda.zip"
  # infrastructure/iam.md: lambda-api-search connects via RDS Proxy as
  # search_api_readonly (migration 20260301000001 —
  # apps/api-search/migrations). Read-only on both catalog and
  # discovery (SPEC-08 §21's personalization ranking signal reads
  # discovery.interest_events, the same table api-feed reads).
  # Originally RDS Proxy IAM auth; switched to a stored password
  # (terraform/modules/rds-proxy's header comment) after both of RDS
  # Proxy's IAM auth modes were tried against the real deployed stack
  # and abandoned.
  api_search_db_user = "search_api_readonly"
}

data "aws_iam_policy_document" "api_search_rds_connect" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_search_db_user]]
  }
}

module "lambda_api_search" {
  source = "../../modules/lambda-service"

  environment  = "prod"
  service_name = "api-search"

  filename         = local.api_search_zip
  source_code_hash = filebase64sha256(local.api_search_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  # SPEC-08 §26 targets (<250ms search, <300ms facets) assume a warm
  # Lambda; the ranking query runs several correlated subqueries per
  # row, so this gets a higher timeout than api-catalog's simple reads,
  # matching api-publisher-import's reasoning for the same bump.
  timeout = 30

  # private-isolated tier: Search only ever needs RDS Proxy, same as
  # Catalog/Feed (infrastructure/networking.md) — no NAT, no internet path.
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_search_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_search_db_user]
    CDN_BASE_URL           = "https://cdn.${var.domain_name}"
    # SPEC-08 §21 — personalization ranking boost, off by default,
    # same feature-flag convention as apps/api-feed.
    FEATURE_PERSONALIZED_RANKING = "false"
  }

  additional_policy_json   = data.aws_iam_policy_document.api_search_rds_connect.json
  attach_additional_policy = true
}

resource "aws_apigatewayv2_integration" "api_search" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_search.alias_invoke_arn
  payload_format_version = "2.0"
}

# Route keys mirror apps/api-search/src/**/*.controller.ts exactly
# (global prefix "v1", set in create-app.ts). All public — no
# authorization_type set (defaults to NONE), matching api-feed.tf.
locals {
  api_search_routes = {
    search             = { method = "GET", path = "/v1/search" }
    autocomplete       = { method = "GET", path = "/v1/autocomplete" }
    browse_publishers  = { method = "GET", path = "/v1/browse/publishers" }
    browse_authors     = { method = "GET", path = "/v1/browse/authors" }
    browse_themes      = { method = "GET", path = "/v1/browse/themes" }
    browse_collections = { method = "GET", path = "/v1/browse/collections" }
    books_similar      = { method = "GET", path = "/v1/books/{id}/similar" }
  }
}

resource "aws_apigatewayv2_route" "api_search" {
  for_each = local.api_search_routes

  api_id    = module.api_gateway.api_id
  route_key = "${each.value.method} ${each.value.path}"
  target    = "integrations/${aws_apigatewayv2_integration.api_search.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_search" {
  statement_id  = "AllowAPIGatewayInvokeApiSearch"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_search.function_name
  qualifier     = module.lambda_api_search.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
