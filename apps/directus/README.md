# Directus (Editorial Workbench)

SPEC-03's Editorial Workbench. The running service is the official
`directus/directus` image with one custom Flow operation extension
baked in — there is no application code of our own beyond that
extension and the config-as-code bootstrap script in this directory.

## Layout

- `Dockerfile` — multi-stage build: compiles
  `extensions/operations/eventbridge-put-event` with its own toolchain,
  then layers the result onto the pinned upstream `directus/directus`
  image. Built and pushed to the shared ECR repo
  (`terraform/bootstrap/ecr.tf`) by
  `.github/workflows/build-directus-image.yml` — the running ECS task
  sits in the private-isolated subnet tier with no NAT/internet route
  (ADR-009's reasoning, applied to ECS instead of Lambda), so it can
  never pull from Docker Hub directly.
- `extensions/operations/eventbridge-put-event/` — a custom Directus
  Flow "operation" extension. Backs SPEC-03's "Trigger catalog publish
  event" flow: it calls EventBridge `PutEvents` directly via
  `@aws-sdk/client-eventbridge`, running in Directus's main Node
  process under the ECS task's own IAM role
  (`infrastructure/iam.md`'s direct `ecs-directus` → `events:PutEvents`
  grant). This is why it's a real extension and not Flows' built-in
  "Run Script" operation — that runs in a sandboxed VM with no AWS SDK
  or outbound network access by design; only a real extension gets the
  task role's credentials.
- `scripts/bootstrap.ts` — config-as-code: tracks the `catalog` +
  `staging` Postgres tables as Directus collections
  (`plan/contracts/directus/collections.md`) and creates the Catalog
  Editor / Senior Editor roles + policies + permissions from SPEC-03.
  Run with `DIRECTUS_URL`, `DIRECTUS_ADMIN_EMAIL`,
  `DIRECTUS_ADMIN_PASSWORD` set: `pnpm --filter directus run bootstrap`.
  Idempotent — safe to re-run.

## Known issue — bootstrap not live-verified

Every migration/Terraform/extension-build/typecheck step in this phase
was validated for real (see each file's own comments for specifics).
The one thing that could **not** be validated end-to-end is a running
Directus instance: both Directus 11.17.4 and 12.1.1 crashed during
first-boot bootstrap in an earlier local sandbox, at the built-in
`20251014A-add-project-owner` migration, with an error trying to
introspect `public.pgmigrations`. That reproduced identically against a
completely empty, isolated database with none of this repo's schemas
or tables present — proving it wasn't caused by anything in this repo
(our migrations, our grants, our schema layout).

**Update**: 11.17.4's crash has since reproduced live, against the real
prod RDS Postgres (identical error/stack) — after the real networking,
TLS, and IAM issues blocking the DB connection itself were all fixed,
Directus reached this exact migration and crashed the same way. So the
earlier "may not reproduce on RDS Postgres in real AWS" hope did not
pan out; this is confirmed to be a genuine upstream bug in that
Directus version (or a shared bug across the 11.x/12.x lines — 12.1.1
was never independently re-verified live, only carried over from the
earlier sandbox finding). `directus/directus:12.1.1` is also the
current latest upstream release as of this writing, so there's no
newer patch to try.

**Currently pinned: 10.13.4** — a prior sandbox attempt at this version
never actually reached a live boot (it failed a local, unrelated `npm
install` step — a native module, `isolated-vm`, failing to build via
`node-gyp` in that sandbox specifically), so it's a genuinely untested
candidate for this bug, not a ruled-out one. It predates whenever the
`20251014A-add-project-owner` migration was introduced. **Known
consequence**: `extensions/operations/eventbridge-put-event/package.json`
declares `"host": "^11.0.0"` — Directus 10 will very likely refuse to
load this extension at all, meaning SPEC-03's "Trigger catalog publish
event" Flow operation needs re-verifying (or the extension's own host
range and API usage revisited against Directus 10's SDK) once 10.13.4
is confirmed to actually boot cleanly.

Practical consequence: `scripts/bootstrap.ts` and the collection/role/
permission design in this README are written carefully against
Directus's documented API and typechecked against the real
`@directus/sdk` v17 type definitions (no live server needed for that —
`pnpm --filter directus run typecheck` passes), but neither the
bootstrap script nor the `eventbridge-put-event` extension's runtime
behavior have been round-tripped against an actual running Directus.
Treat both as reviewed-but-untested. Before relying on this in a real
environment: confirm the ECS task boots cleanly on 10.13.4 (if it
doesn't either, this needs root-causing against Directus's own issue
tracker rather than another version guess), then run the bootstrap
script and manually verify a Catalog Editor and Senior Editor account
behave as SPEC-03 describes before treating either role as
trustworthy.

## Deliberately out of scope for this pass

- **M:N junction fields** (`work_authors`, `book_contributors`,
  `work_themes`, `work_genres`, `work_literary_movements`,
  `book_collections`) — `plan/contracts/directus/collections.md` calls
  for these to be exposed as Directus's built-in M:N alias relationship
  fields rather than separate browsable collections. Wiring that via
  the Relations API is finicky and version-sensitive; it's left as a
  follow-up once there's a live instance to iterate against. In the
  meantime, Directus will still auto-detect the plain FK columns
  (`books.work_id`, `books.publisher_id`, etc.) as ordinary many-to-one
  relations once both sides are tracked collections — only the
  many-to-many junction UX is missing, not basic relational navigation.
- **AI Assisted Enrichment** flows (SPEC-03) — explicitly listed there
  as a future capability, not part of this phase.
