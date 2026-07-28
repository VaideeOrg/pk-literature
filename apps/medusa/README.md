# Medusa (Commerce Admin Surface)

SPEC-06's Medusa responsibilities: "Order management, Customer
management, Shipment status, Refunds, Admin UI. No catalog ownership."
The actual customer-facing commerce API (cart, checkout, payments,
orders — SPEC-06's `APIs` list) is entirely implemented by
`apps/api-commerce`, already built, tested against real Postgres, and
deployed as `lambda-api-commerce`. This directory is the admin-side
Medusa deployment referenced by that spec's architecture diagram's
"Commerce Service → Medusa Admin" step and by
`repository-layout.md`/ADR-009's NAT-tier consequence ("{commerce,
Medusa}").

## Layout

- `medusa-config.ts` — real Medusa v2 project config (`defineConfig`
  from `@medusajs/framework/utils`), connecting to the same RDS
  Postgres instance every other service uses, as the `medusa_app` role
  (migration `20260401000004_medusa_app_role.sql`,
  `apps/api-commerce/migrations`).
- `src/subscribers/eventbridge-order-placed.ts` — one subscriber
  demonstrating the "Medusa event → EventBridge PutEvents" wiring
  pattern (mirrors `apps/directus/extensions/operations/eventbridge-put-event`'s
  role for SPEC-03). See its own header comment for why it's scoped to
  Medusa's built-in `order.placed` event rather than SPEC-06's
  `OrderShipped`/`RefundIssued`.
- `Dockerfile` — builds this project with `medusa build`, then installs
  the build output's own `package.json` in a slim runtime image. Pushed
  to the shared ECR repo (`terraform/bootstrap/ecr.tf`) by
  `.github/workflows/build-medusa-image.yml`, mirroring
  `build-directus-image.yml`.

## Scope boundary — Medusa does not read/write `commerce.*` in this pass

Migration `20260401000004_medusa_app_role.sql` grants `medusa_app` full
CRUD on the `commerce` schema (the same tables `apps/api-commerce`
writes to) — that grant is forward-looking, not yet exercised by any
code in this repository. This deployment runs **Medusa's own default
order/customer/cart data model**, stored in the `medusa` Postgres
schema (routed there at the DB-role level, not by Medusa config — see
`medusa-config.ts`'s comment), which is a completely separate set of
tables from `commerce.orders`/`commerce.customers`/etc.

Making Medusa's admin UI actually manage the *real* orders
`apps/api-commerce` creates would mean overriding Medusa v2's built-in
`order` module with a custom module whose data model points at
`commerce.orders` instead of Medusa's own schema — Medusa v2's module
architecture assumes a module owns the schema for its own entities, so
this is a genuine customization project (comparable in kind to, but
larger in scope than, `apps/directus`'s deferred M:N-junction-fields
work), not a config change. Deliberately out of scope for this pass.

Practical consequence: as deployed today, Medusa's admin UI is present
and reachable (SPEC-06's "Admin UI" checkbox), but is not yet the tool
an operator would use to mark a real order Shipped or issue a real
refund against `commerce.orders` — `apps/api-commerce`/Postgres remain
the actual system of record for every real cart, checkout, order, and
payment in this repo today. `OrderCancelled`/`OrderShipped`/
`RefundIssued` (added to `packages/contracts/src/events.ts` and
`plan/contracts/events/` this phase) have no publisher yet as a direct
consequence — they're contracts waiting for that future module, not
events any code in this repo currently emits.

## Known issue — resolved, now live-verified

Same disclosed-limitation category as `apps/directus/README.md`: every
file in this app is written directly against Medusa v2's documented
config/subscriber API shapes (`medusa-config.ts`'s shape and
`tsconfig.json` were confirmed against Medusa's own published
`medusa-starter-default` template, not guessed), but **no live Medusa
instance has been booted in this sandbox** — `medusa build` /
`medusa develop` were not run here. Reasons this wasn't attempted:
`@medusajs/medusa` and its dependency tree are large (the same
`isolated-vm`-class native-module risk that broke Directus 10.13.4's
`npm install` in this sandbox is a real possibility here too, and a
full `medusa build` needs a reachable Postgres to introspect at build
time in some flows), and Directus's own attempt — a much lighter
service — already spent significant effort in this sandbox and still
could not get past first-boot. Treat this app as reviewed-but-untested.

**Update**: the first real live boot (real prod ECS/RDS) crashed every
Medusa module (Tax, Payment, Fulfillment, Notification, ...) with
`relation "medusa.<table>" does not exist` — confirming the concern
above about an unverified boot path. Root cause: the Dockerfile's
`CMD` only ran `medusa start`, never Medusa's own `medusa db:migrate` —
migration `20260401000004_medusa_app_role.sql` deliberately only
creates the `medusa` schema/role, leaving Medusa's own module tables to
Medusa's own migration CLI (a separate mechanism from every other hand-
written SQL migration in this repo). Fixed by running `medusa
db:migrate` before `medusa start` in the Dockerfile's `CMD` (safe on
every boot — MikroORM tracks applied migrations, and `desired_count = 1`
means no concurrent task to race against).

**A second, transient failure was seen once**: the very first cold-start
attempt crashed with `relation "medusa.publishable_api_key_sales_channel"
does not exist` (a module-link pivot table, created via Medusa's
`defineLink()` system, not any single module's own migrations) while
`create-defaults` tried to link the default sales channel to the
default publishable API key. `medusa db:migrate` syncs module links by
default in 2.17.2 (confirmed against the CLI source and official docs
— no separate `db:sync-links` step is required), so this was most
likely a one-time race on the very first empty-database run rather than
a real gap; ECS's normal crash-and-restart behavior retried the task
automatically, and the very next attempt logged `Syncing links...` →
`Created following links tables ... (publishable_api_key_sales_channel)`
→ `Links sync completed` → `Server is ready on port: 9000` cleanly, and
has stayed up since.

**Now confirmed live**: the admin UI at `https://medusa.<domain>/app`
loads and an admin user (created via a one-off `aws ecs run-task`
override running `npx medusa user -e <email> -p <password>` against the
live task definition, since Medusa has no `ADMIN_EMAIL`/`ADMIN_PASSWORD`
auto-provisioning env vars the way Directus does) can log in
successfully. The scope-boundary section above still applies — this
runs Medusa's own default data model in the `medusa` schema, not
`commerce.*` — before pointing real operators at it for order work,
re-evaluate that section and decide whether the custom-module
integration it describes is still out of scope.
