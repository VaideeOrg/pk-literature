# apps/web deployed via @opennextjs/aws (next.config.ts / package.json's
# opennext:build script): a "server" Lambda handles every SSR/RSC
# request (this app renders `dynamic = "force-dynamic"` everywhere —
# see app/layout.tsx — so there is no static HTML to fall back to), an
# "image" Lambda handles next/image's on-the-fly resizing, and a plain
# S3 bucket serves the content-hashed /_next/static/* build output.
#
# Deliberately NOT built here: OpenNext's ISR/on-demand-revalidation
# queue+Lambda. This app has no static/ISR pages to revalidate (every
# route opts out of static generation — see app/layout.tsx's comment on
# why), so that piece of the standard OpenNext topology would be dead
# infrastructure. Documented scope cut, not an oversight — revisit if a
# future phase adds any statically-generated route back.

resource "aws_s3_bucket" "static_assets" {
  bucket        = "pk-literature-${var.environment}-web-static"
  force_destroy = true

  tags = {
    Environment = var.environment
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "static_assets" {
  bucket                  = aws_s3_bucket.static_assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Bucket policy (Origin Access Control) is created in the cloudfront
# module, same reasoning as modules/s3's media bucket: it needs both
# this bucket's ARN and the distribution's own ARN, and only the module
# creating the distribution can reference both without a module cycle.

module "server_lambda" {
  source = "../lambda-service"

  environment  = var.environment
  service_name = "web-server"

  filename         = var.server_zip_path
  source_code_hash = var.server_zip_hash
  artifact_bucket  = var.artifact_bucket
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  memory_size      = var.server_memory_size
  timeout          = var.server_timeout

  # No VPC placement: this function only makes outbound HTTPS calls to
  # the public apps/api-* endpoints (api.${domain_name}), the same way
  # a visitor's browser would — it doesn't touch RDS/RDS Proxy directly,
  # so it has no reason to pay a VPC's cold-start/ENI cost.
  environment_variables = var.server_environment_variables
}

resource "aws_lambda_function_url" "server" {
  function_name      = module.server_lambda.function_name
  qualifier          = module.server_lambda.alias_name
  authorization_type = "AWS_IAM"
}

module "image_lambda" {
  source = "../lambda-service"

  environment  = var.environment
  service_name = "web-image"

  filename         = var.image_zip_path
  source_code_hash = var.image_zip_hash
  artifact_bucket  = var.artifact_bucket
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  memory_size      = var.image_memory_size
  timeout          = var.image_timeout
  # @opennextjs/aws installs sharp's arm64 prebuilt binary for this
  # function specifically (confirmed by actually running `open-next
  # build` — see modules/lambda-service's architectures variable).
  architectures = ["arm64"]
}

# NONE, not AWS_IAM like the server function url above — deliberate,
# documented deviation. This was AWS_IAM + CloudFront OAC originally
# (matching the server origin's pattern), but a live incident left
# every /_next/image request 403ing with a raw Lambda Function URL
# "AccessDeniedException" with no CloudWatch log line at all (the
# request never reached the function code — rejected at the Function
# URL's own auth layer). Every piece of the OAC/IAM chain was
# independently verified correct live (resource policy statement,
# SourceArn, FunctionUrlAuthType condition, qualifier match between the
# permission and the Function URL, OAC signing behavior) and matched
# the server origin's own already-proven-working setup exactly, byte
# for byte - yet it still failed, and no further AWS-side cause was
# found (CloudTrail data events weren't checked before this was applied
# as the pragmatic fix). Public is an acceptable tradeoff for this one
# origin specifically: it only resizes already-public cover images
# pulled from the public media CDN, so an unauthenticated caller could
# at worst waste invocations directly against the raw URL, not reach
# anything sensitive. Revisit AWS_IAM + OAC later via CloudTrail if
# tightening this back up matters.
resource "aws_lambda_function_url" "image" {
  function_name      = module.image_lambda.function_name
  qualifier          = module.image_lambda.alias_name
  authorization_type = "NONE"
}
