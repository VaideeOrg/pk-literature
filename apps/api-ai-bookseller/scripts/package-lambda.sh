#!/usr/bin/env bash
# Produces apps/api-ai-bookseller/dist-lambda.zip — the artifact
# terraform/environments/prod/api-ai-bookseller.tf's aws_lambda_function
# references directly via `filename`/`source_code_hash`. Identical
# approach to apps/api-feed/scripts/package-lambda.sh — see that
# script's comments for why `pnpm deploy --prod` + `zip -y` instead of
# a raw tar/zip.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
STAGING_DIR="$ROOT_DIR/.lambda-package/api-ai-bookseller"
ZIP_PATH="$APP_DIR/dist-lambda.zip"

echo "==> Building workspace packages (contracts, api-ai-bookseller)"
(cd "$ROOT_DIR" && pnpm --filter @pk-literature/contracts --filter api-ai-bookseller run build)

echo "==> Resolving a self-contained package (pnpm deploy --prod)"
rm -rf "$STAGING_DIR"
(cd "$ROOT_DIR" && pnpm --filter api-ai-bookseller deploy --prod "$STAGING_DIR")

echo "==> Normalizing file timestamps for a reproducible archive"
find "$STAGING_DIR" -exec touch -h -t 198001010000.00 {} +

echo "==> Zipping"
rm -f "$ZIP_PATH"
(cd "$STAGING_DIR" && zip -rqyX "$ZIP_PATH" . -x "*.git*")

echo "==> Done: $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
