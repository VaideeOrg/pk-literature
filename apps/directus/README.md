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

**10.13.4 was then tried live and DID boot further than 11.17.4** — it
successfully created its own system tables ("Installing Directus system
tables..." in the real CloudWatch logs), but then crashed immediately
afterward at `runSeed`'s own "Database is already installed" check
(`api/src/database/seeds/run.ts`'s guard against the `directus_collections`
table already existing — tripping on the very tables it had just
created moments earlier, in the same single bootstrap invocation).
This is a *different* step than 11.17.4's migration crash, but the same
class of bug: Directus's own bootstrap orchestration incorrectly
believing the database is already installed, immediately after
installing it for the first time.

Two follow-up theories were tried and ruled out against this exact
10.13.4 failure, live:
- **Schema/search_path**: `directus_app`'s search_path was scoped to
  the dedicated `directus` schema only (not `public`) — a documented
  Directus limitation for non-public-schema deployments. Adding
  `public` to the search_path (migration
  `20260101000012_directus_search_path_include_public.sql`) plus a
  fresh schema reset made no difference — identical crash, same step.
- **`bootstrap --skipAdminInit`**: investigated but never actually
  wired up, because reading Directus's own source
  (`api/src/cli/commands/bootstrap/index.ts`,
  `api/src/database/seeds/run.ts`) showed this flag only skips
  `createAdmin()` — a step neither the 11.17.4 nor the 10.13.4 crash
  ever reached. Both crashes happen in core install/migration/seed code
  that runs unconditionally regardless of this flag, so it would not
  have helped.

**Currently pinned: 12.1.1** — the current latest upstream release.
Its "also crashes" data point (noted above) was only ever secondhand,
carried over from an earlier local-sandbox investigation and never
independently re-verified live by this session against real RDS
Postgres — worth treating as a fresh, unconfirmed test rather than a
known-bad result. **Known consequence**:
`extensions/operations/eventbridge-put-event/package.json`'s `host`
range has been widened from `^11.0.0` to `^11.0.0 || ^12.0.0` to let
Directus 12 load it at all — that only controls whether the extension
loader accepts it, not whether its runtime API is actually unchanged
between major versions, so the "Trigger catalog publish event" Flow
operation needs re-verifying (or the extension's own API usage
revisited) once 12.1.1 is confirmed to actually boot.

**Root cause confirmed**: a third theory was tried live against 12.1.1
— connecting Directus directly to RDS instead of through RDS Proxy
(`terraform/modules/security-groups/main.tf`'s `ecs_directus_to_rds`,
`directus.tf`'s `DB_HOST`), on the hypothesis that RDS Proxy's
connection multiplexing might be routing Directus's own bootstrap
queries to different physical backends mid-sequence. With a genuinely
fresh `directus` schema (migration
`20260101000014_reset_directus_schema_for_rds_direct.sql`) and TLS
actually working (`DB_SSL__CA_FILE`, not `DB_SSL__CA` — see that
migration's own history), Directus got dramatically further than any
previous attempt: it installed its system tables and applied ~80 of its
own built-in schema migrations, then crashed at the *same*
`20251014A-add-project-owner` migration 11.17.4 hit months earlier
**through RDS Proxy** — ruling out RDS Proxy as the cause, since the
identical failure now reproduced with RDS Proxy completely out of the
connection path.

The actual error this time was more specific:
`TypeError: Cannot read properties of undefined (reading 'primary')`,
inside `getAllowedSort` → `getAstFromQuery` → `RelationsService.readAll`
→ `getDatabaseSchema` → `getSchema()`, called mid-migration. Research
against Directus's own source and issue tracker confirmed this is a
known, documented limitation: `getDatabaseSchema()` builds its
`collections` map purely from `@directus/schema`'s physical-table
introspection, which has a long-standing gap with non-`public` Postgres
schemas (directus/directus discussion #12057: "Directus performs schema
introspection using only the explicitly set search path"; issues #3228
and #24592 show the same "collection missing from introspected schema"
symptom). This repo ran Directus's own tables in a dedicated `directus`
schema (`naming.md`'s schema-per-domain convention, migration
`20260101000006_directus_app_role.sql`) — even with `public` added to
the search_path as a fallback (migration `20260101000012`), Directus's
own introspection code doesn't reliably see its tables outside
`public`. There is no official override (unlike Medusa's explicit
`databaseSchema` config key, `medusa-config.ts`) — Directus maintainers'
documented position is to not run its own tables outside `public`.

**Fix**: migration `20260101000015_directus_use_public_schema.sql`
moves `directus_app` to the `public` schema entirely (unused by every
other service in this repo — verified by grepping every
`apps/*/migrations/*.sql`) and drops the now-unused `directus` schema.
No Terraform/Dockerfile change needed — this is purely a DB-role-level
fix. Still needs a live re-test to confirm it actually resolves the
crash.

Practical consequence: `scripts/bootstrap.ts` and the collection/role/
permission design in this README are written carefully against
Directus's documented API and typechecked against the real
`@directus/sdk` v17 type definitions (no live server needed for that —
`pnpm --filter directus run typecheck` passes), but neither the
bootstrap script nor the `eventbridge-put-event` extension's runtime
behavior have been round-tripped against an actual running Directus.
Treat both as reviewed-but-untested. Before relying on this in a real
environment: confirm the ECS task boots cleanly now that Directus owns
the `public` schema, then run the bootstrap script and manually verify
a Catalog Editor and Senior Editor account behave as SPEC-03 describes
before treating either role as trustworthy.

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
