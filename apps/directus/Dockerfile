# Editorial Workbench (SPEC-03). Multi-stage: build the custom Flow
# operation extension (eventbridge-put-event) with its own toolchain,
# then layer its dist/ output onto the official image.
#
# Extensions must land FLAT under extensions/<name>/ - NOT nested
# under a type subdirectory like extensions/operations/<name>/, despite
# that being an older, no-longer-current Directus convention this
# Dockerfile originally followed. Confirmed live against the deployed
# 12.1.1: @directus/extensions/dist/node.js's resolveFsExtensions()
# lists folders directly under EXTENSIONS_PATH and treats each one as
# ONE extension, reading <folder>/package.json as its manifest - with
# the old operations/<name>/ nesting, it found exactly one folder
# ("operations"), failed to read a nonexistent operations/package.json,
# silently discarded it (try/catch swallows the error), and returned
# zero extensions. The extension's own manifest
# (directus:extension.type) declares its type; directory nesting by
# type isn't how Directus discovers it.
#
# See ../README.md's "Known issue" for the full history: Directus
# 11.17.4 crashed on first boot against the real prod RDS Postgres at
# its own built-in `20251014A-add-project-owner` migration; 10.13.4
# (an older major version, predating that migration) got further but
# hit the same class of bug at a different step (runSeed's own
# "Database is already installed" false-positive, immediately after
# successfully creating its own tables). Both crashes turned out to be
# in core install/migration code that runs unconditionally — not
# something version pinning or a --skipAdminInit-style flag can route
# around.
#
# Now trying 12.1.1. Its "also crashes" data point was only ever
# secondhand (from an earlier local-sandbox investigation, never
# independently confirmed live by this session against real RDS
# Postgres) — worth treating as a fresh, unconfirmed test rather than a
# known-bad result. The eventbridge-put-event extension's declared
# `host` range (package.json) has been widened from `^11.0.0` to also
# cover 12.x to unblock this — that only controls whether Directus's
# loader accepts the extension, not whether its runtime API is actually
# unchanged between major versions, so this is itself untested.
#
# All three versions failed identically, always through RDS Proxy — the
# one constant across every attempt. RDS Proxy multiplexes logical
# client connections onto fewer physical Postgres backends, which is a
# plausible mechanism for the observed pattern (create tables, then the
# very next query claims they don't exist). directus.tf now points
# DB_HOST at RDS directly, bypassing the proxy, the same way
# apps/migration-runner already does for an unrelated RDS Proxy
# interaction issue. A direct RDS connection needs Amazon's own RDS CA
# bundle for TLS verification — unlike RDS Proxy, whose certificate
# chains to a publicly-trusted root, RDS's own certificate doesn't
# verify against Node's default trust store (the exact
# "self-signed certificate in certificate chain" error
# apps/migration-runner hit the first time it connected directly to RDS
# — see its own header comment). Downloaded at build time (this stage
# has real internet access; the running container's own private-isolated
# subnet doesn't), same source AWS publishes and migration-runner's own
# packaging script already uses.
#
# DIRECTUS_VERSION must be declared here, before the first FROM — an
# ARG used in a FROM's image reference has to be declared before *any*
# FROM in the file, or it's scoped only to whichever stage it's inside
# and never reaches a later FROM at all (confirmed by a real `docker
# build --build-arg DIRECTUS_VERSION=...` silently resolving to an
# empty base image name when this was declared between the two
# stages instead).
ARG DIRECTUS_VERSION=12.1.1

FROM node:20-bookworm-slim AS extension-build
WORKDIR /build
COPY extensions/operations/eventbridge-put-event/package.json ./
RUN npm install
COPY extensions/operations/eventbridge-put-event/ ./
RUN npm run build
# ca-certificates is only a Recommends of curl on Debian, not a hard
# dependency - --no-install-recommends alone skipped it, leaving no
# /etc/ssl/certs/ca-certificates.crt for curl to verify against
# ("curl: (77) error setting certificate file", a real build failure).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /build/rds-ca-bundle.pem

# Separate stage (own WORKDIR, own npm install) rather than folding
# into the stage above - same isolation reasoning as the two apps
# having separate package.json/node_modules in the first place: an
# unrelated change to one extension's source shouldn't bust the
# other's Docker layer cache.
FROM node:20-bookworm-slim AS extension-build-promote
WORKDIR /build
COPY extensions/operations/promote-staging-book/package.json ./
RUN npm install
COPY extensions/operations/promote-staging-book/ ./
RUN npm run build

FROM node:20-bookworm-slim AS extension-build-decrement
WORKDIR /build
COPY extensions/operations/decrement-inventory-stock/package.json ./
RUN npm install
COPY extensions/operations/decrement-inventory-stock/ ./
RUN npm run build

FROM node:20-bookworm-slim AS extension-build-image-url-display
WORKDIR /build
COPY extensions/displays/image-url/package.json ./
RUN npm install
COPY extensions/displays/image-url/ ./
RUN npm run build

FROM directus/directus:${DIRECTUS_VERSION}
COPY --from=extension-build /build/dist /directus/extensions/eventbridge-put-event/dist
COPY --from=extension-build /build/package.json /directus/extensions/eventbridge-put-event/package.json
COPY --from=extension-build /build/rds-ca-bundle.pem /directus/rds-ca-bundle.pem
COPY --from=extension-build-promote /build/dist /directus/extensions/promote-staging-book/dist
COPY --from=extension-build-promote /build/package.json /directus/extensions/promote-staging-book/package.json
COPY --from=extension-build-decrement /build/dist /directus/extensions/decrement-inventory-stock/dist
COPY --from=extension-build-decrement /build/package.json /directus/extensions/decrement-inventory-stock/package.json
COPY --from=extension-build-image-url-display /build/dist /directus/extensions/image-url-display/dist
COPY --from=extension-build-image-url-display /build/package.json /directus/extensions/image-url-display/package.json
