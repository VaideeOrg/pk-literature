# apps/web (Next.js App Router, @opennextjs/aws) — customer-facing
# storefront, deployed at the bare domain_name. Added in its own file
# per development/branching.md ("each phase owns its own infra"), same
# convention as every other environments/<env>/<service>.tf. Deployment
# packages built by apps/web/scripts/package-opennext.sh.
#
# NEXT_PUBLIC_* vars (API_BASE_URL's browser-facing twin, CDN host,
# Razorpay key) are NOT set here — Next.js inlines them into the client
# JS bundle at `next build` time, so they have to be exported as shell
# env vars in whatever CI step runs package-opennext.sh, not configured
# as Lambda runtime environment (see runbooks/deploy.md). Only the
# plain, server-runtime-read API_BASE_URL belongs in this Lambda's
# environment_variables.

locals {
  web_server_zip = "${path.module}/../../../apps/web/dist-server-lambda.zip"
  web_image_zip  = "${path.module}/../../../apps/web/dist-image-lambda.zip"
}

module "opennext" {
  source = "../../modules/opennext"

  environment     = "prod"
  artifact_bucket = module.lambda_artifacts.bucket_id

  server_zip_path = local.web_server_zip
  server_zip_hash = filebase64sha256(local.web_server_zip)
  server_environment_variables = {
    API_BASE_URL     = "https://api.${var.domain_name}/v1"
    COMING_SOON_MODE = var.coming_soon_mode ? "true" : "false"
  }

  image_zip_path = local.web_image_zip
  image_zip_hash = filebase64sha256(local.web_image_zip)
}

module "cloudfront_web" {
  source = "../../modules/cloudfront-web"

  environment                = "prod"
  domain_name                = var.domain_name
  cloudfront_certificate_arn = module.route53_acm.cloudfront_certificate_arn
  hosted_zone_id             = module.route53_acm.zone_id

  static_assets_bucket_id                   = module.opennext.static_assets_bucket_id
  static_assets_bucket_arn                  = module.opennext.static_assets_bucket_arn
  static_assets_bucket_regional_domain_name = module.opennext.static_assets_bucket_regional_domain_name

  server_function_url_domain = module.opennext.server_function_url_domain
  server_function_arn        = module.opennext.server_function_arn
  image_function_url_domain  = module.opennext.image_function_url_domain
  image_function_arn         = module.opennext.image_function_arn
}
