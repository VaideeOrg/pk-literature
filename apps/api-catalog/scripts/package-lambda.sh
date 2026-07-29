#!/usr/bin/env bash
# Produces apps/api-catalog/dist-lambda.zip — the artifact
# terraform/environments/<env>/api-catalog.tf's aws_lambda_function
# references directly via `filename`/`source_code_hash`.
#
# Why not a raw `tar czf dist node_modules`: pnpm's node_modules is a
# content-addressable store with symlinks (e.g.
# node_modules/@pk-literature/contracts -> ../../packages/contracts) —
# Lambda's runtime needs real files, not symlinks pointing outside the
# zip. `pnpm deploy` is pnpm's own answer to exactly this: it resolves
# every workspace:* dependency into a real, self-contained copy.
#
# Must be run (or run again) after any change to this app or the
# packages it depends on — there's no Terraform-triggered auto-rebuild
# (a null_resource local-exec was considered and rejected: it couples
# Terraform's apply cycle to a Node build, which is worse to debug than
# just running this script explicitly before `terraform plan/apply`,
# matching how deploy.md already describes the pipeline: build, then
# deploy, as separate steps).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$APP_DIR/../.." && pwd)"
# Deliberately OUTSIDE apps/api-catalog: `pnpm deploy`'s target-path
# resolution doubles the package's own relative path (apps/api-catalog/
# apps/api-catalog/...) when the target lives inside the source
# package's own directory tree — observed directly, not a hypothetical.
STAGING_DIR="$ROOT_DIR/.lambda-package/api-catalog"
ZIP_PATH="$APP_DIR/dist-lambda.zip"

echo "==> Building workspace packages (domain-types, contracts, api-catalog)"
(cd "$ROOT_DIR" && pnpm --filter @pk-literature/domain-types --filter @pk-literature/contracts --filter api-catalog run build)

echo "==> Resolving a self-contained package (pnpm deploy --prod)"
rm -rf "$STAGING_DIR"
(cd "$ROOT_DIR" && pnpm --filter api-catalog deploy --prod "$STAGING_DIR")

echo "==> Normalizing file timestamps for a reproducible archive"
# `pnpm deploy` writes every file with its own fresh mtime on every
# run, even when the file's content is byte-for-byte identical to the
# last build — zip embeds those mtimes, so source_code_hash (computed
# over the zip's own bytes, see the .tf file's filebase64sha256() call)
# changed on literally every build regardless of whether this app's
# code actually changed. With `publish = true` on the Lambda resource
# (terraform/modules/lambda-service/main.tf), that meant a spurious new
# published version on every single terraform apply — including
# infra-only applies that never touched this app at all, since
# terraform-apply.yml rebuilds every service's package unconditionally.
# Confirmed live: every function had ~50 accumulated versions, and
# AWS's own ListVersionsByFunction response for that many versions blew
# past the AWS SDK's decoder buffer limit ("bufio.Scanner: token too
# long"), breaking `terraform plan`/`apply` outright. -h/--no-dereference
# touches symlinks themselves, not their (in-archive) targets. 1980-01-01
# is the earliest date the classic zip/DOS timestamp format can
# represent — Unix epoch (1970) gets silently clamped/warned about by
# zip instead.
find "$STAGING_DIR" -exec touch -h -t 198001010000.00 {} +

echo "==> Zipping"
rm -f "$ZIP_PATH"
# -y: store symlinks as symlinks, do NOT dereference them. pnpm's
# node_modules is full of symlinks into its .pnpm store reached from
# many different paths; without -y, zip stores each symlink's target
# content independently every time it's followed, ballooning a 73MB
# tree into a 108MB archive (measured directly). With -y the archive
# preserves the symlinks themselves (~15MB), and Lambda's extraction —
# a normal filesystem unzip — resolves them correctly at cold start
# since every symlink target lives inside the same archive.
# -X: strip UID/GID and other extra-field metadata from each entry —
# the remaining piece of the archive's bytes that could otherwise vary
# between build environments/runners independently of file content.
(cd "$STAGING_DIR" && zip -rqyX "$ZIP_PATH" . -x "*.git*")

echo "==> Done: $ZIP_PATH ($(du -h "$ZIP_PATH" | cut -f1))"
