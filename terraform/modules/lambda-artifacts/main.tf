# Staging bucket for Lambda deployment packages. aws_lambda_function's
# inline `filename` upload path (base64-encoding the whole zip directly
# into the UpdateFunctionCode request body) hit a hard, reproducible
# provider/SDK limit once these zips grew past a few MB — confirmed
# live against every service's function, regardless of individual zip
# size: "updating Lambda Function (...) code: operation error Lambda:
# UpdateFunctionCode, decomposing request: bufio.Scanner: token too
# long". S3-mediated deployment (upload here, then aws_lambda_function
# references s3_bucket/s3_key instead of filename) keeps the actual
# UpdateFunctionCode API call to a small JSON body referencing this
# object — AWS Lambda pulls the bytes server-side, so no large binary
# ever needs to be encoded/decoded by the provider itself. This is also
# the generally-recommended approach for any Lambda package beyond a
# few MB, not just a workaround for this specific bug.

resource "aws_s3_bucket" "this" {
  bucket        = "pk-literature-${var.environment}-lambda-artifacts"
  force_destroy = true

  tags = {
    Environment = var.environment
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Every object here is keyed by its own source_code_hash (see
# lambda-service/main.tf's aws_s3_object.code), so nothing is ever
# overwritten in place — old builds just accumulate as new, distinct
# keys. Auto-expire instead of needing another manual prune later, the
# same class of unbounded-growth problem the Lambda published-versions
# cleanup just fixed.
resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-old-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = 90
    }
  }
}
