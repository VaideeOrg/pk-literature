# migration-runner

A one-off Lambda, not a service. It exists solely to run
`node-pg-migrate` against the real RDS instance from *inside* the VPC
(RDS is `private-isolated` — no NAT, no Internet Gateway, unreachable
from a GitHub Actions runner or from CloudShell in default network
mode). See `plan/implementation-blueprint/runbooks/deploy.md` §4 for
the full picture; this README only covers what's specific to this app.

## What it does

`src/index.ts`'s `handler` runs each of `api-catalog`, `api-feed`,
`api-search`, `api-commerce`, `api-identity`'s own `migrations/*.sql`
files via node-pg-migrate's programmatic `runner()`, in that fixed
order — `api-catalog` first, because the other four's own
`*_role.sql` migrations grant against schemas/roles it creates.
(`api-publisher-import` has no migrations of its own; its DB role is
created by `api-catalog`'s.)

Connects with the RDS master credential
(`/pk-literature/<env>/rds/master`), fetched from Secrets Manager at
cold start (`src/resolve-master-credential.ts`) — never a plain
Lambda environment variable, per `infrastructure/secrets.md`. It has
to be the master user: the app DB roles are what these migrations
*create*, so nothing else can run them from a cold start.

Connects **directly to RDS** (`PGHOST` = `module.rds.db_address`), not
through RDS Proxy — RDS doesn't support IAM database authentication
for the master user at all, and the proxy's master auth entry
deliberately requires IAM auth, so no master connection can ever
succeed through the proxy (`terraform/modules/rds-proxy`'s header
comment; confirmed by a real `IAM authentication failed for the role
pk_literature_admin` error from the first live invocation). It has its
own dedicated security group (`migration_runner`,
`terraform/modules/security-groups`) with direct ingress on RDS's own
security group, rather than reusing another service's.

Connecting directly to RDS also means verifying RDS's own TLS
certificate, not RDS Proxy's — RDS's cert chains to Amazon's
RDS-specific CA hierarchy, which isn't in Node's default trusted root
bundle (confirmed by a real `self-signed certificate in certificate
chain` error the first time this ran after the RDS Proxy fix above).
`scripts/package-lambda.sh` downloads AWS's published RDS CA bundle at
build time and `src/index.ts` passes it as `ssl.ca` — verification
stays on (`rejectUnauthorized: true`), it's just now checking against
the right root.

### Syncing stored-password DB role passwords

After migrations, `src/sync-role-passwords.ts` runs `ALTER ROLE ...
WITH PASSWORD` for every stored-password DB role — `directus_app`,
`medusa_app`, and (since RDS Proxy IAM auth was tried and abandoned for
them; see `terraform/modules/rds-proxy`'s header comment)
`catalog_api_readonly`, `feed_api_rw`, `search_api_readonly`,
`commerce_api_rw`, `identity_api_rw`, `publisher_import_writer` —
keeping each one's real Postgres password in sync with its own
Secrets Manager secret (`ROLE_PASSWORD_SECRET_ARNS`, a JSON-encoded
`{ roleName: secretArn }` map). `CREATE ROLE ... WITH LOGIN` alone
never sets a password; nothing did this before, for any of these
roles — a real, pre-existing gap that only became visible once a role
actually needed to authenticate this way for real (a live
`publisher_import_writer` connection attempt through RDS Proxy failing
with `PAM authentication failed` after two different RDS Proxy IAM
auth approaches, both eventually abandoned). A checked-in SQL migration
could never do this sync itself without leaking the password value
into git, so it's this Lambda's own code, run with the master
credential it already holds, not a `*.sql` file.

## Not a normal service

- **No HTTP trigger, no API Gateway route.** `terraform/environments/<env>/migration-runner.tf`
  only creates the Lambda + its IAM role — applying it changes nothing
  at runtime. It runs only when explicitly invoked:

  ```sh
  aws lambda invoke \
    --function-name pk-literature-<env>-migration-runner \
    --cli-binary-format raw-in-base64-out \
    --payload '{}' \
    out.json
  ```

  `{"direction": "down"}` reverts the most recent migration per
  service (services run in reverse order) — same one-migration-at-a-time
  default as each service's own `pnpm migrate:down`, not a full
  rollback.

  `out.json` (and CloudWatch Logs for the invocation) includes
  `catalog.publishers`' current contents (`id`/`code`/`name`) after
  every run — a seed migration's generated UUID (e.g. the Kalachuvadu
  row `20260101000009_seed_kalachuvadu_publisher.sql` inserts) is
  readable straight from this invocation's own output, no separate
  `psql`/SQL client session just to find an id a `workflow_dispatch`
  input needs (`publisher-import.yml`).

- **Not built or invoked by `terraform-apply.yml`.** A migration run
  is a deliberate action, not a side effect of every infra apply —
  mirrors how `build-directus-image.yml`/`build-medusa-image.yml` are
  separate, manual-trigger-only workflows.

## Packaging

`scripts/package-lambda.sh` builds this app, then — unlike every other
service's `package-lambda.sh` — also copies each of the 5 services'
`migrations/` directories into the deployment package (they live in
sibling app directories this Lambda would otherwise never see at
runtime) and downloads AWS's RDS CA bundle (see above), before
zipping. Must be re-run whenever this app's code changes, whenever any
of those 5 services gains a new migration file, or periodically to
pick up CA bundle updates (it's re-downloaded fresh on every package,
not pinned to a checked-in copy).

## Known limitation

Invoked for real multiple times against the live RDS instance —
migrations for all five services apply cleanly, `catalog.publishers`
seeding is confirmed, and the role-password sync step above has been
exercised for the six formerly-IAM-auth roles. Not yet independently
confirmed for `directus_app`/`medusa_app` specifically against a
running Directus/Medusa task (both apps have their own disclosed,
separate "not live-verified" limitations — see `apps/directus/README.md`
and `apps/medusa/README.md`'s "Known issue" sections).
