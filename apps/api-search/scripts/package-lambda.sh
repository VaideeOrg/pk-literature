#!/usr/bin/env bash
# Produces apps/api-search/dist-lambda.zip — the artifact
# terraform/environments/<env>/api-search.tf's aws_lambda_function
# references directly via `filename`/`source_code_hash`. Identical
# approach to apps/api-catalog/scripts/package-lambda.sh — see that
# script's comments for why `pnpm deploy --prod` + `zip -y` instead of
# a raw tar/zip.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
STAGING_DIR="$ROOT_DIR/.lambda-package/api-search"
ZIP_PATH="$APP_DIR/dist-lambda.zip"

echo "==> Building workspace packages (domain-types, contracts, api-search)"
(cd "$ROOT_DIR" && pnpm --filter @pk-literature/domain-types --filter @pk-literature/contracts --filter api-search run build)

echo "==> Resolving a self-contained package (pnpm deploy --prod)"
rm -rf "$STAGING_DIR"
(cd "$ROOT_DIR" && pnpm --filter api-search deploy --prod "$STAGING_DIR")

echo "==> Normalizing file timestamps for a reproducible archive"
# See apps/api-catalog/scripts/package-lambda.sh's matching comment —
# without this, source_code_hash changes on every build regardless of
# actual code changes, publishing a spurious new Lambda version on
# every terraform apply and eventually breaking `terraform plan`/`apply`
# outright once accumulated versions blow past the AWS SDK's response
# decoder limit.
find "$STAGING_DIR" -exec touch -h -t 198001010000.00 {} +

echo "==> Zipping"
rm -f "$ZIP_PATH"
(cd "$STAGING_DIR" && zip -rqyX "$ZIP_PATH" . -x "*.git*")

echo "==> Done: $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
