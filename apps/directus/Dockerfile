# Editorial Workbench (SPEC-03). Multi-stage: build the custom Flow
# operation extension (eventbridge-put-event) with its own toolchain,
# then layer its dist/ output onto the official image — Directus loads
# extensions by directory convention (extensions/operations/<name>/dist).
#
# See ../README.md's "Known issue" — Directus 11.17.4 crashed on first
# boot against the real prod RDS Postgres (not just this repo's own
# sandbox, where 11.17.4 and 12.1.1 both crashed identically) at its
# own built-in `20251014A-add-project-owner` migration. 10.13.4 is an
# older major version, from before that migration existed, being tried
# as the next real candidate — genuinely untested for this bug (a prior
# session's only attempt at it failed a local, unrelated npm install
# step, never actually reaching a live boot). Known consequence: the
# eventbridge-put-event extension below declares `host: "^11.0.0"`
# (package.json), so Directus 10 will very likely refuse to load it —
# the "Trigger catalog publish event" Flow operation (SPEC-03) would
# need re-verifying once 10.13.4 actually boots.
#
# DIRECTUS_VERSION must be declared here, before the first FROM — an
# ARG used in a FROM's image reference has to be declared before *any*
# FROM in the file, or it's scoped only to whichever stage it's inside
# and never reaches a later FROM at all (confirmed by a real `docker
# build --build-arg DIRECTUS_VERSION=...` silently resolving to an
# empty base image name when this was declared between the two
# stages instead).
ARG DIRECTUS_VERSION=10.13.4

FROM node:20-bookworm-slim AS extension-build
WORKDIR /build
COPY extensions/operations/eventbridge-put-event/package.json ./
RUN npm install
COPY extensions/operations/eventbridge-put-event/ ./
RUN npm run build

FROM directus/directus:${DIRECTUS_VERSION}
COPY --from=extension-build /build/dist /directus/extensions/operations/eventbridge-put-event/dist
COPY --from=extension-build /build/package.json /directus/extensions/operations/eventbridge-put-event/package.json
