# AI Tamil Bookseller feature — thin Lambda proxy (apps/api-ai-bookseller)
# in front of the ai-service EC2 host (ai-bookseller-ec2.tf). Added in
# its own file per development/branching.md ("each phase owns its own
# infra"), same as api-feed.tf/api-catalog.tf. Deployment package built
# by apps/api-ai-bookseller/scripts/package-lambda.sh.

locals {
  api_ai_bookseller_zip = "${path.module}/../../../apps/api-ai-bookseller/dist-lambda.zip"
}

module "lambda_api_ai_bookseller" {
  source = "../../modules/lambda-service"

  environment  = "prod"
  service_name = "api-ai-bookseller"

  filename         = local.api_ai_bookseller_zip
  source_code_hash = filebase64sha256(local.api_ai_bookseller_zip)
  artifact_bucket  = module.lambda_artifacts.bucket_id
  handler          = "dist/src/lambda.handler"
  runtime          = "nodejs20.x"
  memory_size      = 256
  timeout          = 15 # covers the 8s LLM timeout + 1 retry + a margin, per spec's own numbers

  # private-isolated tier: this Lambda never touches Postgres/RDS Proxy
  # at all (book context passed through from the frontend, usage events
  # logged to CloudWatch, not a table) — the first Lambda in this repo
  # with zero DB access. Its own dedicated SG (not lambda_db) since its
  # egress needs are entirely different: reach the AI Bookseller EC2
  # host and Secrets Manager, nothing RDS-Proxy-shaped at all. See
  # modules/security-groups/main.tf's "AI Tamil Bookseller feature"
  # section for the full reasoning.
  subnet_ids         = module.vpc.private_isolated_subnet_ids
  security_group_ids = [module.security_groups.lambda_ai_bookseller_sg_id]

  environment_variables = {
    # Plain runtime env var, same convention as web.tf's COMING_SOON_MODE
    # — a terraform apply flips it, no Lambda redeploy needed. Defaults
    # off; flip to "true" once the EC2 host is confirmed healthy.
    FEATURE_AI_BOOKSELLER = tostring(var.feature_ai_bookseller)

    # Private IP of the AI Bookseller EC2 host — see that resource's own
    # comment for why a static private IP (not a Route53 record/ALB) is
    # enough here (spec: "No ALB ... for MVP").
    AI_SERVICE_BASE_URL = "http://${aws_instance.ai_bookseller.private_ip}:5000"

    # Resolved into the plain AI_SERVICE_AUTH_TOKEN env var at cold start
    # by resolve-secret-env-vars.ts — secrets.md's "environment variables
    # hold the ARN, the runtime resolves it" convention, same as
    # api-commerce's RAZORPAY_*_SECRET_ARN vars.
    AI_SERVICE_AUTH_TOKEN_SECRET_ARN = module.secrets_manager.ai_bookseller_internal_token_secret_arn
  }

  additional_policy_json   = data.aws_iam_policy_document.api_ai_bookseller_secrets.json
  attach_additional_policy = true
}

data "aws_iam_policy_document" "api_ai_bookseller_secrets" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets_manager.ai_bookseller_internal_token_secret_arn]
  }
}

resource "aws_apigatewayv2_integration" "api_ai_bookseller" {
  api_id                 = module.api_gateway.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.lambda_api_ai_bookseller.alias_invoke_arn
  payload_format_version = "2.0"
}

# Public — no authorization_type set (defaults to NONE), matching
# api-feed's routes: the AI Bookseller feature is fully anonymous by
# spec, no login required.
resource "aws_apigatewayv2_route" "api_ai_bookseller_chat" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/ai/chat"
  target    = "integrations/${aws_apigatewayv2_integration.api_ai_bookseller.id}"
}

resource "aws_apigatewayv2_route" "api_ai_bookseller_asr" {
  api_id    = module.api_gateway.api_id
  route_key = "POST /v1/ai/asr"
  target    = "integrations/${aws_apigatewayv2_integration.api_ai_bookseller.id}"
}

resource "aws_apigatewayv2_route" "api_ai_bookseller_health" {
  api_id    = module.api_gateway.api_id
  route_key = "GET /v1/ai/health"
  target    = "integrations/${aws_apigatewayv2_integration.api_ai_bookseller.id}"
}

resource "aws_lambda_permission" "api_gateway_invoke_api_ai_bookseller" {
  statement_id  = "AllowAPIGatewayInvokeApiAiBookseller"
  action        = "lambda:InvokeFunction"
  function_name = module.lambda_api_ai_bookseller.function_name
  qualifier     = module.lambda_api_ai_bookseller.alias_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${module.api_gateway.api_execution_arn}/*/*"
}
