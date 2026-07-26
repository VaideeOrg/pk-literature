import { loadEnv, defineConfig } from "@medusajs/framework/utils";

loadEnv(process.env.NODE_ENV || "production", process.cwd());

// Built from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, not read
// directly from a single DATABASE_URL env var — matches every other
// service in this repo's env var convention (apps/api-commerce etc.)
// and, more importantly, matches how ECS task-definition `secrets`
// actually works: it injects one Secrets Manager value per env var
// (terraform/environments/<env>/medusa.tf's `secrets = { PGPASSWORD =
// module.secrets_manager.medusa_db_password_secret_arn }`), which can
// only ever be the bare password, not a pre-assembled connection
// string with a password embedded in it. Connects as medusa_app
// (migration 20260401000004_medusa_app_role.sql). Unlike every
// RDS-Proxy-IAM-auth Lambda in this repo, this is a genuinely stored
// password — same exception apps/directus/README.md documents
// (Medusa's Postgres client, like Directus's Knex client, has no
// dynamic IAM token refresh support).
//
// databaseSchema: real-tested requirement, not guessed — the migration
// also sets `ALTER ROLE medusa_app SET search_path TO medusa`, which
// looked sufficient on paper but is NOT what Medusa's own MikroORM
// migrator uses: it reads config.options.schema
// (@medusajs/utils/dist/dal/mikro-orm/custom-db-migrator.js) and, when
// unset, issues `CREATE TABLE mikro_orm_migrations (...)` with no
// schema qualification and no search_path fallback at all — confirmed
// against a real local Postgres in this sandbox, where `medusa db:migrate`
// failed with Postgres error 3F000 "no schema has been selected to
// create in" until this field was added. The role-level search_path
// grant stays in the migration as a reasonable default for any
// ad-hoc/manual psql session as medusa_app; this field is what
// Medusa's own tooling actually reads.
//
// No REDIS_URL is configured: Medusa falls back to its in-memory event
// bus / workflow engine, which only works correctly with exactly one
// running instance — acceptable for this repo's single-ECS-task
// deployment (terraform/environments/<env>/medusa.tf runs
// desired_count = 1, same as apps/directus), but would need Redis
// (ElastiCache, not provisioned anywhere in this repo) before ever
// scaling to more than one task.
const databaseUrl =
  process.env.DATABASE_URL ??
  `postgres://${process.env.PGUSER}:${encodeURIComponent(process.env.PGPASSWORD ?? "")}@${process.env.PGHOST}:${process.env.PGPORT ?? "5432"}/${process.env.PGDATABASE}`;

// RDS Proxy requires TLS (confirmed by Directus's own real "This RDS
// Proxy requires TLS connections" FATAL against the same proxy); a bare
// databaseUrl with no ssl option connects without TLS and gets rejected
// the same way. PGSSL=disable mirrors every Lambda service's own
// database.module.ts convention for local dev (docker-compose has no
// TLS listener). rejectUnauthorized: true is safe here — unlike a
// direct RDS instance connection (apps/migration-runner needs a bundled
// CA for that), RDS Proxy presents a publicly-trusted certificate.
const databaseDriverOptions =
  process.env.PGSSL === "disable" ? {} : { connection: { ssl: { rejectUnauthorized: true } } };

module.exports = defineConfig({
  projectConfig: {
    databaseUrl,
    databaseDriverOptions,
    databaseSchema: process.env.DATABASE_SCHEMA || "medusa",
    http: {
      storeCors: process.env.STORE_CORS || "",
      adminCors: process.env.ADMIN_CORS || "",
      authCors: process.env.AUTH_CORS || "",
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
});
