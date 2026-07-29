#!/usr/bin/env bash
# Produces apps/migration-runner/dist-lambda.zip — the artifact
# terraform/environments/<env>/migration-runner.tf's aws_lambda_function
# references via `filename`/`source_code_hash`.
#
# Same pnpm-deploy-then-zip-with-symlinks-preserved approach as
# apps/api-catalog/scripts/package-lambda.sh (see that script's own
# comments for why plain `tar`/`zip -r` over node_modules doesn't
# work with pnpm's symlink-based store). What's different here: this
# Lambda has no code of its own to run migrations against — it needs
# each of the 5 services' migrations/*.sql files bundled in too, since
# those live in sibling app directories this package would otherwise
# never see at runtime.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
STAGING_DIR="$ROOT_DIR/.lambda-package/migration-runner"
ZIP_PATH="$APP_DIR/dist-lambda.zip"

MIGRATION_SERVICES=(api-catalog api-feed api-search api-commerce api-identity)

echo "==> Building migration-runner"
(cd "$ROOT_DIR" && pnpm --filter migration-runner run build)

echo "==> Resolving a self-contained package (pnpm deploy --prod)"
rm -rf "$STAGING_DIR"
(cd "$ROOT_DIR" && pnpm --filter migration-runner deploy --prod "$STAGING_DIR")

echo "==> Copying migrations/ from each service this Lambda runs"
mkdir -p "$STAGING_DIR/migrations"
for service in "${MIGRATION_SERVICES[@]}"; do
  src="$ROOT_DIR/apps/$service/migrations"
  if [ ! -d "$src" ]; then
    echo "error: expected migrations directory not found: $src" >&2
    exit 1
  fi
  cp -r "$src" "$STAGING_DIR/migrations/$service"
done

# src/index.ts reads this to verify RDS's own TLS certificate — RDS's
# cert chains to Amazon's RDS-specific CA hierarchy, not a publicly
# trusted root, so Node's default trust store rejects it
# ("self-signed certificate in certificate chain") without this.
# Downloaded here (build time, CI has internet access) rather than
# fetched at runtime (this Lambda's VPC has none) or embedded as a
# literal in source (AWS rotates/adds intermediates within this
# bundle over time; re-downloading on every package keeps it current
# without a manual update step).
echo "==> Downloading RDS CA bundle"
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o "$STAGING_DIR/rds-ca-bundle.pem"

echo "==> Normalizing file timestamps for a reproducible archive"
# See apps/api-catalog/scripts/package-lambda.sh's matching comment —
# without this, source_code_hash changes on every build regardless of
# actual code changes, publishing a spurious new Lambda version on
# every terraform apply and eventually breaking `terraform plan`/`apply`
# outright once accumulated versions blow past the AWS SDK's response
# decoder limit. Run after the migrations/ copy and CA bundle download
# above so those files' timestamps get normalized too, not just
# pnpm deploy's own output.
find "$STAGING_DIR" -exec touch -h -t 198001010000.00 {} +

echo "==> Zipping"
rm -f "$ZIP_PATH"
(cd "$STAGING_DIR" && zip -rqyX "$ZIP_PATH" . -x "*.git*")

echo "==> Done: $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
