# Deploy

Operational runbook for taking `dev` from nothing to a running
environment, and for routine deploys after that. `qa`/`prod` follow the
same shape once their `terraform-apply.yml` jobs are uncommented
(`development/branching.md`'s "each phase owns its own infra" —
nothing environment-specific changes except which job runs).

This is written from a real pre-deploy audit of everything currently in
`main` (all of Phases 0–7) — every step below reflects what the code
and Terraform actually require, not an idealized process. Section 6 is
an open gap, not a solved problem — read it before you start.

---

## 1. One-time account setup: `terraform/bootstrap`

Applied once, manually, by a human with admin AWS credentials — never
by CI (`terraform/bootstrap/README.md`).

```sh
cd terraform/bootstrap
terraform init
terraform plan
terraform apply
```

Before running this:

- **`state_bucket_name`** (`terraform/bootstrap/variables.tf`, default
  `pk-literature-terraform-state`) must be globally unique across every
  AWS account, not just this one. Confirm it's free, or pass a
  different value, before the first apply — it cannot be changed
  afterward without a state migration.

After it applies, take its outputs and wire them in by hand:

1. `gha_deploy_role_arns` → GitHub repo/environment variables
   `AWS_DEPLOY_ROLE_ARN_DEV` (and `_QA`/`_PROD` once those jobs are
   uncommented in `.github/workflows/terraform-apply.yml`).
2. `state_bucket_name` / `state_lock_table_name` → confirm they match
   what's already hardcoded in each `terraform/environments/<env>/backend.tf`
   (they should, since both sides use the same defaults — this is a
   sanity check, not a copy step, unless you changed the bootstrap
   variable above).
3. `gha_publisher_import_role_arns` → `AWS_PUBLISHER_IMPORT_ROLE_ARN_DEV`
   (repo/environment variable, read by `.github/workflows/publisher-import.yml`).

From this point on, `terraform/environments/` is applied by CI
(`terraform-apply.yml`, `workflow_dispatch`-gated), never manually —
see that workflow's own header comment for why.

---

## 2. Fill in placeholders before the first `environments/dev` apply

- **`terraform/environments/{dev,qa,prod}/terraform.tfvars`** —
  `domain_name` and `alarm_email` are placeholders
  (`dev.pk-literature.example`, `alerts+dev@pk-literature.example`,
  etc.), each marked `REPLACE before first apply` in the file itself.
  `create_hosted_zone = true` assumes Route 53 doesn't already own this
  domain's zone; set it `false` and reuse an existing zone if it does.
- **GitHub Actions variables** (repo or `dev` environment scope):
  `AWS_DEPLOY_ROLE_ARN_DEV`, `AWS_PUBLISHER_IMPORT_ROLE_ARN_DEV`,
  `KALACHUVADU_BASE_URL`, `ETHIRVELIYEEDU_BASE_URL` (set to
  `https://ethirveliyeedu.com/collections/all/products.json`),
  `STAGING_INGEST_BASE_URL_DEV` (the last one is only known after the
  first apply — see step 4).

---

## 3. First apply: `terraform-apply.yml`

Manual `workflow_dispatch` only — merging to `main` never triggers an
apply by itself (`terraform-apply.yml`'s own header explains why this
is the primary safety gate). The workflow already builds every Lambda's
deployment package before running `terraform apply` (`api-catalog`,
`api-publisher-import`, `api-feed`, `api-search`, `api-commerce`,
`api-identity`, in that order) — you don't need to build anything by
hand for this step.

This creates: VPC + subnets + NAT, RDS + RDS Proxy, S3, CloudFront,
the API Gateway shell + every phase's routes, EventBridge bus + the
`UserRegistered` rule, all 8 Lambda functions, Secrets Manager entries,
and the shared ECS cluster (empty — see step 5).

**What this step does NOT do**: run any database migration, put a
Directus or Medusa image in ECR, or set a real Razorpay credential.
Every Lambda will exist but return 500s against a database with no
schemas until step 4 runs.

---

## 4. Run migrations against the real RDS instance

RDS is deliberately unreachable from anywhere outside the VPC:
`publicly_accessible = false`, and it sits in the `private-isolated`
subnet tier, which has **no route to a NAT Gateway or an Internet
Gateway at all** (`infrastructure/networking.md`). A GitHub
Actions-hosted runner cannot reach it directly, full stop — there is
no amount of security-group tweaking that fixes this, since it's a
routing problem, not a firewall problem.

This is solved via **`apps/migration-runner`**, a dedicated one-off
Lambda (option 3 from this section's earlier draft — a Lambda's
execution environment *is* inside the VPC, unlike a CI runner). It is
not wired to API Gateway and has no HTTP trigger; applying its
Terraform (`terraform/environments/<env>/migration-runner.tf`) changes
nothing at runtime by itself. It runs each service's migrations
in-process via `node-pg-migrate`'s programmatic API, in this fixed
order (api-catalog first, since the others' `*_role.sql` migrations
grant against schemas/roles api-catalog's own migrations create):

```sh
# 1. Build + package (from repo root)
bash apps/migration-runner/scripts/package-lambda.sh

# 2. terraform apply (from terraform/environments/<env>) so the
#    Lambda's code is up to date, if it changed

# 3. Invoke it — this is the step that actually runs migrations
aws lambda invoke \
  --function-name pk-literature-<env>-migration-runner \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  out.json
cat out.json   # per-service migrations applied + catalog.publishers' current contents
```

`{"direction": "down"}` as the payload reverts the most recent
migration per service (services run in reverse order), mirroring each
service's own `pnpm migrate:down` — same one-migration-at-a-time
default as those scripts, not a full rollback.

`out.json` includes `catalog.publishers`' `id`/`code`/`name` after
every run, so a seed migration's generated UUID (e.g.
`20260101000009_seed_kalachuvadu_publisher.sql`) is readable straight
from this invocation's own output — no separate `psql` session needed
just to find the id a `publisher-import.yml` `workflow_dispatch` input
wants.

It connects with the RDS **master credential**
(`/pk-literature/<env>/rds/master` in Secrets Manager —
Terraform/migration-runner bootstrap only, never used by the app roles
themselves, `infrastructure/secrets.md`), resolved at cold start via
the Secrets Manager SDK rather than a plain Lambda environment
variable — it has to be the master user, since the app DB roles each
service's migrations grant (`catalog_api_readonly`, etc.) don't exist
until api-catalog's migrations create them.

It connects **directly to RDS, not through RDS Proxy** — a real first
invocation failed with `The IAM authentication failed for the role
pk_literature_admin`, because RDS doesn't support IAM database
authentication for the master user at all, and the proxy's master auth
entry deliberately requires IAM auth (`modules/rds-proxy`'s header
comment), so no master connection can ever succeed through the proxy,
password or IAM. It uses its own dedicated security group
(`migration_runner`, `modules/security-groups`) with a direct ingress
grant on RDS's own security group, rather than going through the proxy
like every other service does.

(`api-publisher-import` has no migrations of its own — its DB role is
created by `api-catalog`'s migrations, since `api-catalog` owns the
`staging`/`catalog` schemas it grants access to, so it isn't one of
the 5 services `apps/migration-runner` runs.)

This has been built and typechecks. It has now been invoked once for
real: the first attempt surfaced the RDS Proxy issue above (fixed by
connecting directly to RDS instead), and — while fixing that — also
surfaced that Directus's and Medusa's own RDS Proxy connections were
never actually wired up correctly either (their stored-password
secrets were never registered with the proxy's `auth` config at all,
a pre-existing gap this uncovered rather than caused). A second real
invocation, after both fixes land, hasn't happened yet as of this
writing — treat this section as "should work now," not "confirmed."

Two other options were considered and are documented here only as
alternatives, not built:

1. **SSM port-forwarding through a throwaway instance** — add
   `ssmmessages`/`ec2messages`/`ssm` interface endpoints, launch a
   temporary EC2/Fargate-with-SSM-agent instance, tunnel local `5432`
   to RDS's own endpoint (not RDS Proxy — see above), run migrations
   from your laptop. More moving parts than a Lambda for the same
   result.
2. **A one-off ECS Fargate task** running `node-pg-migrate` instead of
   a long-lived server, via `aws ecs run-task`. Viable, but would have
   needed the same direct-to-RDS security-group wiring the Lambda
   above ended up needing anyway.

---

## 5. Directus and Medusa images

Both ECR repos (`pk-literature/directus`, `pk-literature/medusa`) are
empty until you explicitly run their build workflows —
`terraform-apply.yml` never builds or pushes these, on purpose (see
its own header comment). The ECS services from step 3 will apply
successfully either way; tasks just won't start until an image with
the tag `directus_image_tag`/`medusa_image_tag` (`environments/<env>/variables.tf`,
currently `12.1.1`/`2.17.2-1`) exists in ECR.

```
# GitHub Actions → Build Directus Image → Run workflow (directus_version input)
# GitHub Actions → Build Medusa Image   → Run workflow (medusa_image_tag input)
```

Both are `workflow_dispatch`-only, both skip the push if that tag
already exists (repos are `IMMUTABLE`). See `apps/directus/README.md`'s
"Known issue" and `apps/medusa/README.md`'s "Known issue"/"Scope
boundary" sections before assuming either comes up healthy on the
first try — neither has been boot-verified against a live instance;
Directus specifically crashed on first-boot migration in this
project's sandbox for reasons that may or may not reproduce on real
RDS Postgres (documented there, not solved here).

---

## 6. Secrets that need a real value

Everything in Secrets Manager is Terraform-generated *except*:

| Secret | Path | Why it's not auto-generated |
|---|---|---|
| Razorpay key ID | `/<env>/razorpay/key-id` | Issued by Razorpay's dashboard |
| Razorpay key secret | `/<env>/razorpay/key-secret` | Issued by Razorpay's dashboard |
| Razorpay webhook secret | `/<env>/razorpay/webhook-secret` | Issued by Razorpay's dashboard (webhook config) |

These start as `random_password`-generated placeholders with
`lifecycle { ignore_changes = [secret_string] }` — Terraform will never
overwrite a real value you paste in via the AWS Console/CLI, but
checkout/payments will not work against the real Razorpay API until
you do. Directus/Medusa's own secrets (DB password, `KEY`/`SECRET`,
JWT/cookie secrets, admin passwords) and `identity/jwt-signing-secret`
are all genuinely Terraform-generated and need no manual step.

Every IAM-auth DB role needs `rds_iam` granted — this only exists on
real RDS, not vanilla Postgres, which is why the role-creation
migrations (`*_role.sql`) never granted it themselves. It's now its
own migration per service (`*_grant_rds_iam.sql`, one per service that
owns an IAM-auth role — `medusa_app` is excluded, since Medusa
connects with a stored password, not RDS Proxy IAM auth), each guarded
with `IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname =
'rds_iam')` so it's a safe no-op against local/CI Postgres and a real
grant against RDS — no separate manual step, just part of the normal
`apps/migration-runner` invoke (step 4). Verified locally end-to-end
against a real Postgres instance: runs clean as a no-op without
`rds_iam` present, and actually grants membership (confirmed via
`pg_auth_members`) once it is.

(`directus_app` and `medusa_app` don't need this — they use stored
passwords, not RDS Proxy IAM auth; `infrastructure/secrets.md`'s
documented exception.)

---

## 7. Smoke test

No dedicated smoke-test suite exists yet beyond the placeholder job in
`terraform-apply.yml` (`smoke-test-dev`, currently just an `echo`). A
reasonable manual check after steps 1–6:

- `GET https://api.<domain>/v1/health` (routed to `api-catalog`)
- `GET https://api.<domain>/v1/feed`
- `GET https://api.<domain>/v1/search?q=...`
- `POST https://api.<domain>/v1/cart` with an `X-Anonymous-Id` header,
  then `GET` it back
- `POST https://api.<domain>/v1/auth/register`, then `GET /v1/profile`
  with the returned cookie
- `https://directus.<domain>` and `https://medusa.<domain>` load their
  respective admin login screens

---

## Routine deploys after the first one

Once steps 1–2 are done once, a normal deploy is: merge to `main` →
manually run `terraform-apply.yml` (`workflow_dispatch`, `dev`) → if a
migration was added in this change, run it (step 4's mechanism,
whichever was chosen) → if `directus_image_tag`/`medusa_image_tag`
changed, run the corresponding build-image workflow first. `qa`/`prod`
are not part of this loop yet — their jobs in `terraform-apply.yml` are
commented out until someone deliberately re-enables them (see that
file's own comment for the required GitHub Environment reviewer setup
first).
