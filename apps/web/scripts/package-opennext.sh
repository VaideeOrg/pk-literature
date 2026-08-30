#!/usr/bin/env bash
# Produces the two deployment artifacts
# terraform/modules/opennext's aws_lambda_function resources reference
# via `filename`/`source_code_hash`:
#   apps/web/dist-server-lambda.zip
#   apps/web/dist-image-lambda.zip
# Unlike every other service's package-lambda.sh, there's no
# `pnpm deploy --prod` step here — `open-next build` (package.json's
# opennext:build script, @opennextjs/aws) already esbuild-bundles each
# Lambda's code and its dependencies into a single self-contained
# directory per function; zipping that directory as-is is the whole job.
#
# NOT produced by this script: an upload of .open-next/assets (the
# /_next/static/* + public/ build output the S3 origin serves). That's
# a bulk `aws s3 sync` with per-file cache-control headers plus a
# CloudFront invalidation, not a Lambda deployment package — Terraform
# doesn't model that well, so it's a separate step in
# .github/workflows/terraform-apply.yml (after `terraform apply`), not
# something this script or Terraform itself does.
#
# Optional $1: an output suffix, e.g. "sg" -> dist-server-lambda-sg.zip
# / dist-image-lambda-sg.zip. puthagakadai.sg needs its own build (not
# just its own Terraform deployment of the same artifact) because this
# app has no static/ISR pages — everything is `dynamic = "force-dynamic"`
# (app/layout.tsx) — so NEXT_PUBLIC_MARKET/NEXT_PUBLIC_FEATURE_PAY_LATER
# etc. can't be deferred to runtime the way a server-only env var could;
# they're baked into the client bundle at `next build` time by whatever
# NEXT_PUBLIC_* values are exported in the shell before this script
# runs. Called twice in CI with two different env exports — see
# .github/workflows/terraform-apply.yml.
set -euo pipefail

SUFFIX="${1:-}"
SUFFIX_TAG="${SUFFIX:+-$SUFFIX}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
OPEN_NEXT_DIR="$APP_DIR/.open-next"

echo "==> Building workspace packages (domain-types, contracts, ui, web)"
(cd "$ROOT_DIR" && pnpm --filter @pk-literature/domain-types --filter @pk-literature/contracts --filter @pk-literature/ui --filter web run build)

echo "==> Running open-next build"
(cd "$APP_DIR" && pnpm run opennext:build)

package() {
  local src_dir="$1"
  local zip_path="$2"
  if [ ! -d "$src_dir" ]; then
    echo "error: expected open-next output directory not found: $src_dir" >&2
    echo "       (@opennextjs/aws's output layout may have changed — check .open-next/ directly)" >&2
    exit 1
  fi
  # Normalize file timestamps for a reproducible archive — see
  # apps/api-catalog/scripts/package-lambda.sh's matching comment.
  # open-next build re-emits every file fresh on each run, so without
  # this source_code_hash changes on every build regardless of actual
  # code changes, publishing a spurious new Lambda version on every
  # terraform apply.
  find "$src_dir" -exec touch -h -t 198001010000.00 {} +

  rm -f "$zip_path"
  (cd "$src_dir" && zip -rqyX "$zip_path" . -x "*.git*")
  echo "==> Done: $zip_path ($(du -h "$zip_path" | cut -f1))"
}

echo "==> Zipping server function"
package "$OPEN_NEXT_DIR/server-functions/default" "$APP_DIR/dist-server-lambda${SUFFIX_TAG}.zip"

echo "==> Zipping image optimization function"
package "$OPEN_NEXT_DIR/image-optimization-function" "$APP_DIR/dist-image-lambda${SUFFIX_TAG}.zip"

echo "==> Static assets to sync separately (not zipped): $OPEN_NEXT_DIR/assets"
