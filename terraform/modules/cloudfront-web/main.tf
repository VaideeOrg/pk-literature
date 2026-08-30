# apps/web's own distribution, deliberately separate from
# modules/cloudfront (which serves catalog.media_assets at
# cdn.${domain_name} and is already relied on by every previously-shipped
# phase's stored/generated URLs). Folding the two together — as an
# earlier phase's leftover comment in modules/cloudfront originally
# proposed — would mean moving the media origin onto a /media/* path
# behavior, which changes the URL shape every already-merged phase
# (Directus config, apps/api-catalog, etc.) already writes into
# catalog.media_assets.s3_key-derived URLs. Not worth that blast radius
# just to save one distribution; this app gets its own at the bare
# domain_name instead.

locals {
  static_origin_id = "web-static-s3"
  server_origin_id = "web-server-lambda"
  image_origin_id  = "web-image-lambda"
}

resource "aws_cloudfront_origin_access_control" "static_assets" {
  name                              = "pk-literature-${var.environment}-${var.service_name}-static"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_origin_access_control" "server_lambda" {
  name                              = "pk-literature-${var.environment}-${var.service_name}-server"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Unused — deliberately kept around rather than deleted. The image
# origin's Function URL is authorization_type = "NONE" (public) now,
# not AWS_IAM (modules/opennext's own comment on
# aws_lambda_function_url.image has the full story), so nothing
# references this OAC's id anymore. A first attempt actually removed
# this resource outright, which immediately broke the ENTIRE site
# (server origin included) for the length of two separate failed
# applies: deleting an OAC in the same apply as removing its last
# reference races CloudFront's own internal detachment, and it
# deterministically 409'd both times with "OriginAccessControlInUse"
# before Terraform ever reached the distribution update that actually
# needed to happen — the whole apply aborts on that one fatal error, so
# nothing else in the run (including the fix) got applied either. Kept
# declared-but-unreferenced here instead; safe to actually delete in a
# later, standalone apply once there's no risk of it blocking anything
# load-bearing in the same run.
resource "aws_cloudfront_origin_access_control" "image_lambda" {
  name                              = "pk-literature-${var.environment}-${var.service_name}-image"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# AWS-managed policy, looked up by name rather than hardcoded ID so
# this doesn't depend on getting a UUID right from memory. Used by the
# server origin's default_cache_behavior below — see that block's
# comment for why a request forwarded via the legacy forwarded_values
# API (which always includes Host) breaks OAC's SigV4 signing.
data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# The image Lambda's own cache policy — can't reuse caching_disabled
# above since /_next/image responses genuinely benefit from edge
# caching (unlike the server origin, every response here is a pure
# function of its query string), but the legacy forwarded_values API
# this replaced can't be used for an OAC-signed origin (see above), so
# TTLs/query-string/Accept-header forwarding all have to be expressed
# through this resource instead of that block's own min/default/max_ttl
# + forwarded_values arguments.
resource "aws_cloudfront_cache_policy" "image_optimization" {
  name        = "pk-literature-${var.environment}-${var.service_name}-image"
  min_ttl     = 0
  default_ttl = 3600
  max_ttl     = 86400

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["Accept"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
  }
}

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  aliases         = [var.domain_name]
  comment         = "pk-literature-${var.environment}-${var.service_name}"

  origin {
    domain_name              = var.static_assets_bucket_regional_domain_name
    origin_id                = local.static_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.static_assets.id
  }

  origin {
    domain_name              = var.server_function_url_domain
    origin_id                = local.server_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.server_lambda.id

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 30
      origin_keepalive_timeout = 5
    }
  }

  origin {
    domain_name = var.image_function_url_domain
    origin_id   = local.image_origin_id

    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "https-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 25
      origin_keepalive_timeout = 5
    }
  }

  # Every route in this app is `dynamic = "force-dynamic"` (app/layout.tsx
  # — CartLink/AccountLink in the shared header forward the visitor's
  # anonymous_id/auth cookies on every request), so nothing here is
  # cacheable at the edge; this behavior exists to route requests to the
  # server Lambda and forward what it needs, not to cache responses.
  #
  # Uses the modern cache-policy/origin-request-policy resources, not
  # the legacy forwarded_values API — this is AWS's own documented
  # pattern for an origin signed via Origin Access Control (OAC), which
  # computes a SigV4 signature over the request CloudFront actually
  # sends. A first attempt just removed "Host" from forwarded_values'
  # header allowlist (the known reason forwarding Host breaks OAC
  # signing for a custom origin) and that alone wasn't sufficient — a
  # real `curl -v` still showed a 403 AccessDeniedException straight
  # from the Function URL after that fix was live and confirmed applied
  # (every other piece of the OAC/IAM chain was independently verified
  # correct via the AWS CLI: resource policy, SourceArn, AuthType,
  # origin domain). Managed-AllViewerExceptHostHeader is the policy AWS
  # documents specifically for OAC-signed custom origins — it forwards
  # everything the legacy config did (all cookies, all headers except
  # Host, all query strings) through the officially-supported path
  # instead of the legacy one, on the chance the legacy API has some
  # other OAC-signing quirk beyond just the Host header.
  default_cache_behavior {
    target_origin_id         = local.server_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  # next.config.ts / @opennextjs/aws emit /_next/static/* with
  # content-hashed filenames — safe to cache aggressively and forward
  # nothing.
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.static_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 31536000
    max_ttl     = 31536000
  }

  # next/image requests carry the source path + w/q resize params as a
  # query string and negotiate format via Accept — both need forwarding
  # for a correctly-resized, correctly-formatted response, but no
  # cookies (image bytes don't vary per visitor here). Uses the same
  # modern cache-policy/origin-request-policy resources as the server
  # origin - not required here the way it is for that OAC-signed origin
  # (this origin is public, see aws_lambda_function_url.image's own
  # comment for why), just kept for consistency since it expresses the
  # same forwarding rules the old forwarded_values block did.
  ordered_cache_behavior {
    path_pattern             = "/_next/image"
    target_origin_id         = local.image_origin_id
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = aws_cloudfront_cache_policy.image_optimization.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = var.cloudfront_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_route53_record" "web" {
  zone_id = var.hosted_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.this.domain_name
    zone_id                = aws_cloudfront_distribution.this.hosted_zone_id
    evaluate_target_health = false
  }
}

# OAC bucket policy — same "must live where the distribution ARN is
# available" reasoning as modules/cloudfront's media_oac.
data "aws_iam_policy_document" "static_assets_oac" {
  statement {
    sid       = "AllowCloudFrontServicePrincipal"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.static_assets_bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "static_assets_oac" {
  bucket = var.static_assets_bucket_id
  policy = data.aws_iam_policy_document.static_assets_oac.json
}

# Lambda Function URL OAC — the equivalent of the S3 bucket policy
# above, but granting CloudFront's service principal
# lambda:InvokeFunctionUrl instead of s3:GetObject. The server Function
# URL was created with authorization_type = "AWS_IAM" (modules/opennext),
# so without this, CloudFront's signed OAC requests would be rejected.
# No equivalent permission for the image origin - its Function URL is
# authorization_type = "NONE" (public), which needs no invoke grant at
# all; see aws_lambda_function_url.image's own comment for why.
resource "aws_lambda_permission" "cloudfront_invoke_server" {
  statement_id           = "AllowCloudFrontServicePrincipal"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = var.server_function_arn
  principal              = "cloudfront.amazonaws.com"
  source_arn             = aws_cloudfront_distribution.this.arn
  function_url_auth_type = "AWS_IAM"
}
