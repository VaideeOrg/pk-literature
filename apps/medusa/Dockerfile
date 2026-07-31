# Medusa admin surface (SPEC-06). Two stages: `medusa build` compiles
# this project (medusa-config.ts + src/subscribers) into a
# self-contained production app under .medusa/server (Medusa's own
# documented build output layout), then that output gets its own
# `npm install` in a slim runtime image — mirrors the shape of
# apps/directus/Dockerfile's multi-stage build even though the
# underlying tools differ (Directus layers a compiled extension onto
# an official pre-built image; Medusa has no such image to start from,
# so this repo builds the whole server image itself).
#
# NOT live-verified in this sandbox — see ../README.md's "Known issue"
# section, same disclosed-limitation category as apps/directus's own
# unverified boot.

# --fetch-retries/--fetch-retry-*: @medusajs's dependency tree is large
# enough (hundreds of packages) that a full `npm install` can run long
# enough to trip registry.npmjs.org's own rate limiting - a real build
# failure hit live ("npm error code E429 - 429 Too Many Requests - GET
# .../@medusajs%2fjs-sdk", ~8 minutes into the install). npm's default
# retry config (2 retries, up to 60s backoff) wasn't enough to ride out
# that particular 429; more retries and a longer max backoff give a
# sustained rate-limit window more room to clear before giving up.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000
COPY medusa-config.ts tsconfig.json ./
COPY src ./src
RUN npx medusa build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app/.medusa/server ./
RUN npm install --omit=dev --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

ENV NODE_ENV=production
EXPOSE 9000
# `medusa start` alone never creates Medusa's own tables (tax_provider,
# payment_provider, fulfillment_provider, notification_provider,
# region_country, currency, ...) - those belong to Medusa's own modules
# and are only created by its own migration CLI, entirely separate from
# this repo's hand-written SQL migrations (20260401000004_medusa_app_role.sql
# only creates the medusa schema/role, deliberately leaving Medusa's own
# tables to Medusa's own tooling - see its own comment). `medusa db:migrate`
# is safe to run on every boot (MikroORM tracks applied migrations, so a
# second run against an already-migrated schema is a no-op) - fine at
# desired_count = 1 (medusa.tf) with no concurrent task to race against.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
