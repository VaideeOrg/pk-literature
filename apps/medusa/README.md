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
- `src/lib/commerce-db.ts` / `commerce-orders.repository.ts` — a
  standalone `pg.Pool` and query layer against `commerce.orders` and
  friends, deliberately separate from Medusa's own MikroORM connection
  (see "Custom commerce-orders admin extension" below).
- `src/api/admin/commerce-orders/**` — custom Admin API routes (list,
  detail, status update, add-shipment) reading/writing `commerce.*`
  directly. Automatically covered by Medusa's own `/admin*` auth
  middleware — no separate auth wiring needed.
- `src/admin/routes/commerce-orders/**` — custom Admin UI pages (list +
  detail, registered in the sidebar as "Store Orders" via
  `defineRouteConfig`) that call the routes above.

## Scope boundary — Medusa's own Order module still does not read/write `commerce.*`

Migration `20260401000004_medusa_app_role.sql` grants `medusa_app` full
CRUD on the `commerce` schema (the same tables `apps/api-commerce`
writes to). This deployment still also runs **Medusa's own default
order/customer/cart data model**, stored in the `medusa` Postgres
schema (routed there at the DB-role level, not by Medusa config — see
`medusa-config.ts`'s comment) — Medusa's *built-in* Orders section in
the sidebar is still empty and unused; nothing in this repo writes to
it, and that's deliberate, not a bug.

What changed: rather than overriding Medusa v2's built-in `order`
module to point its own data model at `commerce.orders` — a genuine
module-architecture customization project, since Medusa v2 modules
assume they own their own schema — this pass took the lighter path of
a **custom admin route + custom admin page** (`src/api/admin/
commerce-orders/**`, `src/admin/routes/commerce-orders/**`) that reads/
writes `commerce.*` directly via a plain `pg.Pool`, with no attempt to
integrate with Medusa's Order module or its workflow engine. It shows
up in the sidebar as its own "Store Orders" item, separate from
Medusa's native (empty) "Orders" item.

Practical consequence: `apps/api-commerce`/Postgres remain the actual
system of record for every cart, checkout, order, and payment — this
extension is a thin read/write UI over that same data, not a
replacement for it. An operator can now view orders, update `status`,
and record a shipment (carrier + tracking number, which also advances
the order to `shipped`) from Medusa's admin UI. Not yet wired: issuing
a refund from this UI (`commerce.refunds` is shown read-only — no code
anywhere in this repo calls Razorpay's refund API yet, so there's
nothing for an "initiate refund" button to trigger), and
`OrderCancelled`/`OrderShipped`/`RefundIssued` (`packages/contracts/
src/events.ts`) still have no publisher — this extension writes
directly to Postgres, it doesn't go through `apps/api-commerce`'s own
service layer or its event-publishing.

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
