# Shell only — no routes. Each phase (Catalog, Feed, Search, Commerce,
# Identity) adds its own routes/integrations pointing at its own Lambda
# in its own branch (development/branching.md — infra ownership).

resource "aws_apigatewayv2_api" "this" {
  name          = "pk-literature-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["https://${var.domain_name}"]
    allow_methods = ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    # x-anonymous-id: every anonymous-scoped route since Phase 4
    # (api-feed/api-search/api-commerce) reads this custom header — it
    # was missing from allow_headers this whole time, which silently
    # broke actual cross-origin browser calls at the CORS-preflight
    # layer even though every Lambda-level test in this repo passed
    # (none of them go through a real browser preflight). Fixed here
    # while wiring api-identity, which is the first service that
    # genuinely needs credentialed CORS to matter (HTTP-only cookies).
    allow_headers     = ["content-type", "authorization", "x-anonymous-id"]
    allow_credentials = true
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_apigatewayv2_stage" "v1" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "v1"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 100
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      ip               = "$context.identity.sourceIp"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      responseLength   = "$context.responseLength"
      integrationError = "$context.integrationErrorMessage"
    })
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/pk-literature/${var.environment}/api-gateway"
  retention_in_days = 30
}

resource "aws_apigatewayv2_domain_name" "this" {
  domain_name = "api.${var.domain_name}"

  domain_name_configuration {
    certificate_arn = var.regional_certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_apigatewayv2_api_mapping" "v1" {
  api_id      = aws_apigatewayv2_api.this.id
  domain_name = aws_apigatewayv2_domain_name.this.id
  stage       = aws_apigatewayv2_stage.v1.id
  # No api_mapping_key (maps at the domain root): every route_key below
  # already has a literal "/v1/..." prefix baked in, mirroring each
  # NestJS app's own setGlobalPrefix("v1") — a "v1" mapping key here
  # strips that same segment from the incoming path *before* route
  # matching, so callers would need "/v1/v1/..." to reach anything.
  # Confirmed against the real deployed stack: with the mapping key
  # set, every request to the documented single-"/v1" invoke_url below
  # 404'd with API Gateway's own bare {"message":"Not Found"} — proof
  # the request never reached any Lambda integration at all.
}

resource "aws_route53_record" "api" {
  zone_id = var.hosted_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.this.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}
