# puthagakadai.sg — the Singapore storefront. Same apps/web codebase,
# same backend (VPC/RDS/API Gateway/EventBridge, all reused as-is from
# main.tf/*.tf above) as puthagakadai.com, but its own DNS zone, ACM
# certs, and OpenNext/CloudFront hosting — a second, independently
# deployable frontend rather than a second environment. See
# terraform/modules/opennext and terraform/modules/cloudfront-web's own
# service_name variable comments for why those two specifically needed
# parameterizing before this file could exist without colliding with
# web.tf's resources (S3 bucket names, Lambda function names, OAC
# names, and a cache-policy name are all unique-per-account/globally
# unique and were hardcoded to a literal "web" before that).
#
# NOT duplicated here: route53_acm's provider aliasing, api_gateway,
# eventbridge, or any RDS/VPC resource — this file only ever reads
# their existing outputs (e.g. api.${var.domain_name} as the API base
# URL below), it never re-declares them.

module "route53_acm_sg" {
  source = "../../modules/route53-acm"
  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  environment        = "prod"
  domain_name        = var.domain_name_sg
  create_hosted_zone = var.create_hosted_zone_sg
}

locals {
  web_sg_server_zip = "${path.module}/../../../apps/web/dist-server-lambda-sg.zip"
  web_sg_image_zip  = "${path.module}/../../../apps/web/dist-image-lambda-sg.zip"
}

module "opennext_sg" {
  source = "../../modules/opennext"

  environment     = "prod"
  service_name    = "web-sg"
  artifact_bucket = module.lambda_artifacts.bucket_id

  server_zip_path = local.web_sg_server_zip
  server_zip_hash = filebase64sha256(local.web_sg_server_zip)
  server_environment_variables = {
    # Same shared API Gateway as puthagakadai.com — see
    # terraform/modules/api-gateway's extra_cors_origins for the CORS
    # side of pointing a second frontend at one backend.
    API_BASE_URL     = "https://api.${var.domain_name}"
    COMING_SOON_MODE = var.coming_soon_mode_sg ? "true" : "false"
    # Server Component requests get X-Market: SG this way (plain
    # runtime env var, server-fetch.ts) — the browser-side equivalent
    # (client-fetch.ts's NEXT_PUBLIC_MARKET) is baked in at build time
    # instead, via package-opennext.sh's shell env, not here; see that
    # script's own header comment.
    MARKET = "SG"
  }

  image_zip_path = local.web_sg_image_zip
  image_zip_hash = filebase64sha256(local.web_sg_image_zip)
}

module "cloudfront_web_sg" {
  source = "../../modules/cloudfront-web"

  environment                = "prod"
  service_name               = "web-sg"
  domain_name                = var.domain_name_sg
  cloudfront_certificate_arn = module.route53_acm_sg.cloudfront_certificate_arn
  hosted_zone_id             = module.route53_acm_sg.zone_id

  static_assets_bucket_id                   = module.opennext_sg.static_assets_bucket_id
  static_assets_bucket_arn                  = module.opennext_sg.static_assets_bucket_arn
  static_assets_bucket_regional_domain_name = module.opennext_sg.static_assets_bucket_regional_domain_name

  server_function_url_domain = module.opennext_sg.server_function_url_domain
  server_function_arn        = module.opennext_sg.server_function_arn
  image_function_url_domain  = module.opennext_sg.image_function_url_domain
  image_function_arn         = module.opennext_sg.image_function_arn
}
