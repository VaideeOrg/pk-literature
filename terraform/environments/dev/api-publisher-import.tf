# Phase 3's staging-ingest API (ADR-009) — the only piece of the
# publisher-import pipeline that runs inside AWS. IAM-authenticated
# (authorization_type = AWS_IAM on every route below): only
# gha-publisher-import-<env>'s SigV4-signed requests reach it
# (terraform/bootstrap/gha-publisher-import.tf), not a public route
# like api-catalog's. Deployment package built by
# apps/api-publisher-import/scripts/package-lambda.sh, same convention
# as api-catalog.tf.

locals {
  api_publisher_import_zip = "${path.module}/../../../apps/api-publisher-import/dist-lambda.zip"

  # infrastructure/iam.md: lambda-api-publisher-import connects via RDS
  # Proxy IAM auth as publisher_import_writer (migration
  # 20260101000007_publisher_import_writer_role.sql) — SELECT-only on
  # catalog (duplicate detection), read/write on staging, plus a
  # column-level UPDATE on catalog.publishers' cursor columns only.
  publisher_import_db_user = "publisher_import_writer"
}

data "aws_iam_policy_document" "api_publisher_import_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.publisher_import_db_user]]
  }

  # Staging cover uploads only (common/media-storage.service.ts's
  # `staging/` key prefix) — never the covers/logos/banners prefixes
  # Directus owns, matching SPEC-04 §3's "adapters shall not modify
  # production catalog" applied to media as well as DB rows.
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${module.s3.bucket_arn}/staging/*"]
  }

  statement {
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [module.eventbridge.bus_arn]
  }
}

module "lambda_api_publisher_import" {
  source = "../../modules/lambda-service"

  environment  = "dev"
  service_name = "api-publisher-import"

  filename         = local.api_publisher_import_zip
  source_code_hash = filebase64sha256(local.api_publisher_import_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  # Higher than api-catalog's 10s — a submit can include a cover upload
  # to S3 plus a duplicate-detection query, not just a single read.
  timeout = 30

  # private-isolated tier, same as api-catalog: no NAT, this Lambda
  # never reaches the internet — the crawler already fetched/normalized
  # everything before this receives it (ADR-009).
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.publisher_import_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.publisher_import_db_user]
    AWS_REGION             = data.aws_region.current.name
    EVENTBRIDGE_BUS_NAME   = module.eventbridge.bus_name
    MEDIA_BUCKET_NAME      = module.s3.bucket_id
  }

  additional_policy_json = data.aws_iam_policy_document.api_publisher_import_task.json
}

resource "aws_apigatewayv2_integration" "api_publisher_import" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_publisher_import.alias_invoke_arn
  payload_format_version = "2.0"
}

# Route keys mirror apps/api-publisher-import/src/*/,*.controller.ts
# exactly (global prefix "v1", set in create-app.ts).
locals {
  api_publisher_import_routes = {
    cursor      = { method = "GET", path = "/v1/publishers/{publisherId}/cursor" }
    start_run   = { method = "POST", path = "/v1/publishers/{publisherId}/import-runs" }
    submit_book = { method = "POST", path = "/v1/import-runs/{runId}/books" }
    complete    = { method = "POST", path = "/v1/import-runs/{runId}/complete" }
  }
}

resource "aws_apigatewayv2_route" "api_publisher_import" {
  for_each = local.api_publisher_import_routes

  api_id             = module.api_gateway.api_id
  route_key          = "${each.value.method} ${each.value.path}"
  target             = "integrations/${aws_apigatewayv2_integration.api_publisher_import.id}"
  authorization_type = "AWS_IAM"
}

# No separate health route: unlike Directus/api-catalog this API has no
# load balancer needing a health-check target, and HealthController's
# /v1/health would collide with api-catalog.tf's identical route_key on
# this same shared API Gateway (route_keys must be unique per API) —
# the controller stays for local dev / direct Lambda invoke, just isn't
# wired to a route here.

resource "aws_lambda_permission" "api_gateway_invoke_api_publisher_import" {
  statement_id  = "AllowAPIGatewayInvokeApiPublisherImport"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_publisher_import.function_name
  qualifier     = module.lambda_api_publisher_import.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
