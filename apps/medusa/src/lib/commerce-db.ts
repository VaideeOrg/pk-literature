import { Pool } from "pg";

// A second, standalone Postgres connection, deliberately separate from
// Medusa's own MikroORM connection (medusa-config.ts) — that one is
// permanently scoped to the `medusa` schema via medusa_app's own
// search_path grant (apps/api-commerce/migrations/
// 20260401000004_medusa_app_role.sql), and MikroORM's entity/module
// system has no supported way to run an arbitrary raw query against a
// schema/table it doesn't own an entity for. The commerce-orders admin
// extension (src/api/admin/commerce-orders/**) queries
// `commerce.*` directly instead — a plain query, not a Medusa module,
// so a plain pg.Pool is all it needs. medusa_app already has full
// CRUD on the commerce schema (same migration) — no new DB role/grant
// required for this.
//
// Same env vars and TLS logic as medusa-config.ts's own databaseUrl/
// databaseDriverOptions (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE,
// RDS Proxy requires TLS, PGSSL=disable for local docker-compose which
// has no TLS listener) — kept in sync deliberately since both
// connections point at the same RDS Proxy endpoint under the same
// medusa_app role.
let pool: Pool | undefined;

export function getCommerceDb(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST,
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      ssl: process.env.PGSSL === "disable" ? undefined : { rejectUnauthorized: true },
    });
  }
  return pool;
}
