# Phase 7's User & Identity API (SPEC-07) — public, unauthenticated
# routes at the API Gateway layer (same "no API-Gateway-level auth"
# convention as every other service this repo has built); /profile and
# /addresses/* are protected by apps/api-identity's own JwtAuthGuard
# instead. Added in its own file per development/branching.md ("each
# phase owns its own infra"). Deployment package built by
# apps/api-identity/scripts/package-lambda.sh, same convention as
# api-feed.tf / api-search.tf.

locals {
  api_identity_zip = "${path.module}/../../../apps/api-identity/dist-lambda.zip"
  # infrastructure/iam.md: lambda-api-identity connects via RDS Proxy
  # IAM auth as identity_api_rw (migration 20260501000002 —
  # apps/api-identity/migrations).
  api_identity_db_user = "identity_api_rw"
}

data "aws_iam_policy_document" "api_identity_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_identity_db_user]]
  }

  # POST /auth/register publishes UserRegistered
  # (src/auth/auth.service.ts) — apps/api-commerce's eventbridge-handler
  # consumes it for the anonymous-cart merge.
  statement {
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [module.eventbridge.bus_arn]
  }

  # secrets.md: env vars hold the ARN, resolve-secret-env-vars.ts reads
  # the actual value at cold start via GetSecretValue.
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.identity_jwt_signing_secret_arn]
  }
}

module "lambda_api_identity" {
  source = "../../modules/lambda-service"

  environment  = "qa"
  service_name = "api-identity"

  filename         = local.api_identity_zip
  source_code_hash = filebase64sha256(local.api_identity_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  timeout          = 10

  # private-isolated tier: unlike api-commerce/Medusa, nothing here
  # needs internet egress — no third-party API calls (networking.md
  # already lists api-identity alongside api-catalog/api-feed/api-search).
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_identity_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_identity_db_user]
    AWS_REGION             = data.aws_region.current.name

    EVENTBRIDGE_BUS_NAME = module.eventbridge.bus_name

    JWT_SIGNING_SECRET_ARN = module.secrets_manager.identity_jwt_signing_secret_arn

    # apps/web (bare var.domain_name) and this API (api.${var.domain_name})
    # are sibling subdomains — a leading-dot domain scopes the auth
    # cookies this Lambda sets to the whole family instead of just
    # api.${var.domain_name}, which is what apps/web's server-side
    # fetches (server-fetch.ts) need to actually see them.
    COOKIE_DOMAIN = ".${var.domain_name}"
  }

  additional_policy_json = data.aws_iam_policy_document.api_identity_task.json
}

resource "aws_apigatewayv2_integration" "api_identity" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_identity.alias_invoke_arn
  payload_format_version = "2.0"
}

# Route keys mirror apps/api-identity/src/**/*.controller.ts exactly
# (global prefix "v1", set in create-app.ts).
locals {
  api_identity_routes = {
    auth_register    = { method = "POST", path = "/v1/auth/register" }
    auth_login       = { method = "POST", path = "/v1/auth/login" }
    auth_logout      = { method = "POST", path = "/v1/auth/logout" }
    auth_refresh     = { method = "POST", path = "/v1/auth/refresh" }
    profile_get      = { method = "GET", path = "/v1/profile" }
    profile_patch    = { method = "PATCH", path = "/v1/profile" }
    addresses_list   = { method = "GET", path = "/v1/addresses" }
    addresses_create = { method = "POST", path = "/v1/addresses" }
    addresses_update = { method = "PATCH", path = "/v1/addresses/{id}" }
    addresses_delete = { method = "DELETE", path = "/v1/addresses/{id}" }
  }
}

resource "aws_apigatewayv2_route" "api_identity" {
  for_each = local.api_identity_routes

  api_id    = module.api_gateway.api_id
  route_key = "${each.value.method} ${each.value.path}"
  target    = "integrations/${aws_apigatewayv2_integration.api_identity.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_identity" {
  statement_id  = "AllowAPIGatewayInvokeApiIdentity"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_identity.function_name
  qualifier     = module.lambda_api_identity.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
