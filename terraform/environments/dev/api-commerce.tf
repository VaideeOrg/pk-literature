# Phase 6's Commerce API (SPEC-06) — public, unauthenticated routes
# (anonymous checkout, SPEC-06 Principles: "Anonymous checkout
# supported"; same "no anonymous-session auth mechanism until SPEC-07
# lands" reasoning as api-feed/api-search). Added in its own file per
# development/branching.md ("each phase owns its own infra"). Deployment
# package built by apps/api-commerce/scripts/package-lambda.sh, same
# convention as api-feed.tf / api-search.tf.
#
# Unlike every other Lambda in this repo, this one sits in the
# private-nat subnet tier with lambda_egress_sg, not private-isolated
# with lambda_db_sg — it needs real internet egress to reach Razorpay's
# API (ADR-009's consequence: "NAT Gateway tier: shrinks to {commerce,
# Medusa}"). Everything else about the module usage matches
# api-feed.tf/api-search.tf.

locals {
  api_commerce_zip = "${path.module}/../../../apps/api-commerce/dist-lambda.zip"
  # infrastructure/iam.md: lambda-api-commerce connects via RDS Proxy
  # IAM auth as commerce_api_rw (migration 20260401000003 —
  # apps/api-commerce/migrations). Read/write on commerce, read-only on
  # catalog (checkout's inventory validation).
  api_commerce_db_user = "commerce_api_rw"
}

data "aws_iam_policy_document" "api_commerce_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_commerce_db_user]]
  }

  statement {
    effect    = "Allow"
    actions   = ["events:PutEvents"]
    resources = [module.eventbridge.bus_arn]
  }

  # secrets.md: env vars hold the ARN, resolve-secret-env-vars.ts reads
  # the actual value at cold start via GetSecretValue.
  statement {
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      module.secrets_manager.razorpay_key_id_secret_arn,
      module.secrets_manager.razorpay_key_secret_secret_arn,
      module.secrets_manager.razorpay_webhook_secret_secret_arn,
    ]
  }
}

module "lambda_api_commerce" {
  source = "../../modules/lambda-service"

  environment  = "dev"
  service_name = "api-commerce"

  filename         = local.api_commerce_zip
  source_code_hash = filebase64sha256(local.api_commerce_zip)
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 512
  # Higher than api-feed/api-catalog's default — checkout does a
  # sequential inventory-validate + two-address-insert + transactional
  # order-insert + a Razorpay API round trip on create-order, same
  # class of multi-step-request reasoning as api-search's ranking query.
  timeout = 20

  # private-nat tier, not private-isolated — see file header.
  subnet_ids         = module.vpc.private_nat_subnet_ids
  security_group_ids = [module.security_groups.lambda_egress_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_commerce_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_commerce_db_user]
    AWS_REGION             = data.aws_region.current.name
    CDN_BASE_URL           = "https://cdn.${var.domain_name}"

    EVENTBRIDGE_BUS_NAME = module.eventbridge.bus_name

    RAZORPAY_KEY_ID_SECRET_ARN         = module.secrets_manager.razorpay_key_id_secret_arn
    RAZORPAY_KEY_SECRET_SECRET_ARN     = module.secrets_manager.razorpay_key_secret_secret_arn
    RAZORPAY_WEBHOOK_SECRET_SECRET_ARN = module.secrets_manager.razorpay_webhook_secret_secret_arn

    # See prod/api-commerce.tf's own comment on why these are single
    # shared values, not a per-deployment override.
    PAY_LATER_ENABLED_MARKETS = "SG"
    SHIPPING_COST             = "50"
    SHIPPING_COST_SG          = "3"
  }

  additional_policy_json = data.aws_iam_policy_document.api_commerce_task.json
}

resource "aws_apigatewayv2_integration" "api_commerce" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_commerce.alias_invoke_arn
  payload_format_version = "2.0"
}

# Public — no authorization_type set (defaults to NONE), matching
# api-feed.tf/api-search.tf. SPEC-06's checkout/cart/payment routes have
# no authenticated-user concept until SPEC-07 (Phase 7) lands; ownership
# is scoped by the X-Anonymous-Id header instead, enforced in
# application code, not at the API Gateway layer.
resource "aws_apigatewayv2_route" "api_commerce_post_cart" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/cart"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_get_cart" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/cart"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_patch_cart_items" {
  api_id    = module.api_gateway.api_id
  route_key = "PATCH /v1/cart/items"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_delete_cart_item" {
  api_id    = module.api_gateway.api_id
  route_key = "DELETE /v1/cart/items/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_post_checkout" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/checkout"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_post_payments_create_order" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/payments/create-order"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_post_payments_pay_later" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/payments/pay-later"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

# Razorpay's own servers call this, not a browser — still routed
# through the same public HTTP API; authenticity comes from the HMAC
# signature verification in payments.controller.ts
# (razorpay-signature.ts), not from API Gateway auth.
resource "aws_apigatewayv2_route" "api_commerce_post_payments_webhook" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/payments/webhook"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_get_orders" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/orders"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_apigatewayv2_route" "api_commerce_get_order" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/orders/{id}"
  target    = "integrations/${aws_apigatewayv2_integration.api_commerce.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_commerce" {
  statement_id  = "AllowAPIGatewayInvokeApiCommerce"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_commerce.function_name
  qualifier     = module.lambda_api_commerce.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}

# ---------------------------------------------------------------------
# Phase 7: UserRegistered consumer (SPEC-07 "Anonymous Merge: ... Cart").
# A SEPARATE Lambda function from lambda_api_commerce above — same
# deployment package (apps/api-commerce/dist-lambda.zip bundles both
# entry points), different handler
# (dist/src/eventbridge-handler.handler), invoked directly by an
# EventBridge rule instead of API Gateway. This is the first real
# EventBridge rule + Lambda target in this repo — every prior phase
# only ever published events, never consumed one.
#
# Placed in the private-isolated tier, not private-nat like
# lambda_api_commerce — this handler only ever writes to Postgres
# (commerce.customers, commerce.cart), it never talks to Razorpay, so
# it has no reason to pay for NAT-tier placement or carry Razorpay
# secrets.
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "api_commerce_user_registered_consumer_task" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.iam_auth_role_secret_arns[local.api_commerce_db_user]]
  }
}

module "lambda_api_commerce_user_registered_consumer" {
  source = "../../modules/lambda-service"

  environment  = "dev"
  service_name = "api-commerce-user-registered-consumer"

  filename         = local.api_commerce_zip
  source_code_hash = filebase64sha256(local.api_commerce_zip)
  handler          = "dist/src/eventbridge-handler.handler"
  runtime          = "nodejs20.x"
  memory_size      = 256
  timeout          = 10

  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_db_sg_id]

  environment_variables = {
    PGHOST                 = module.rds_proxy.proxy_endpoint
    PGPORT                 = "5432"
    PGDATABASE             = "pk_literature"
    PGUSER                 = local.api_commerce_db_user
    DB_PASSWORD_SECRET_ARN = module.secrets_manager.iam_auth_role_secret_arns[local.api_commerce_db_user]
    AWS_REGION             = data.aws_region.current.name
  }

  additional_policy_json = data.aws_iam_policy_document.api_commerce_user_registered_consumer_task.json
}

resource "aws_cloudwatch_event_rule" "user_registered" {
  name           = "pk-literature-dev-user-registered"
  event_bus_name = module.eventbridge.bus_name
  event_pattern = jsonencode({
    source      = ["pk-literature.api-identity"]
    detail-type = ["UserRegistered"]
  })
}

resource "aws_cloudwatch_event_target" "user_registered_to_commerce_consumer" {
  rule           = aws_cloudwatch_event_rule.user_registered.name
  event_bus_name = module.eventbridge.bus_name
  arn            = module.lambda_api_commerce_user_registered_consumer.alias_arn
}

resource "aws_lambda_permission" "eventbridge_invoke_user_registered_consumer" {
  statement_id  = "AllowEventBridgeInvokeUserRegisteredConsumer"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_commerce_user_registered_consumer.function_name
  qualifier     = module.lambda_api_commerce_user_registered_consumer.alias_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.user_registered.arn
}
