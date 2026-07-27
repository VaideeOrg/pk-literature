# Editorial Workbench (SPEC-03). Multi-stage: build the custom Flow
# operation extension (eventbridge-put-event) with its own toolchain,
# then layer its dist/ output onto the official image — Directus loads
# extensions by directory convention (extensions/operations/<name>/dist).
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

FROM directus/directus:${DIRECTUS_VERSION}
COPY --from=extension-build /build/dist /directus/extensions/operations/eventbridge-put-event/dist
COPY --from=extension-build /build/package.json /directus/extensions/operations/eventbridge-put-event/package.json
