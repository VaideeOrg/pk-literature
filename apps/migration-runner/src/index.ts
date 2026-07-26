import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import runner from "node-pg-migrate";
import { resolveMasterCredential } from "./resolve-master-credential";
import { syncRolePasswords } from "./sync-role-passwords";

// RDS's own certificate (unlike RDS Proxy's, which chains to a
// publicly-trusted root) is issued by Amazon's RDS-specific CA
// hierarchy, which isn't in Node's default trusted root bundle —
// confirmed by a real "self-signed certificate in certificate chain"
// error the first time this connected directly to RDS instead of
// through the proxy. scripts/package-lambda.sh downloads AWS's
// published RDS CA bundle into the zip root at build time (CI has
// internet access; this Lambda's own VPC-isolated runtime doesn't),
// same two-levels-up-from-dist/src path reasoning as the migrations
// directories below.
const RDS_CA_BUNDLE = fs.readFileSync(path.join(__dirname, "..", "..", "rds-ca-bundle.pem"), "utf8");

interface MigrationRunnerEvent {
  // "down" exists for symmetry with each service's own migrate:down
  // script — not expected to be used in normal operation.
  direction?: "up" | "down";
}

interface ServiceResult {
  service: string;
  migrationsRun: string[];
}

interface PublisherRow {
  id: string;
  code: string;
  name: string;
}

interface RunnerResult {
  services: ServiceResult[];
  // catalog.publishers' current contents, logged (and returned) so a
  // seed migration's generated UUID is readable straight from this
  // invocation's own output/CloudWatch Logs — no separate psql session
  // just to find the id a workflow_dispatch input needs
  // (runbooks/deploy.md's publisher-import.yml step).
  publishers: PublisherRow[];
  // Role names whose real Postgres password was synced from Secrets
  // Manager this run — see sync-role-passwords.ts.
  rolePasswordsSynced: string[];
}

// Order matters: api-catalog's migrations create the catalog/staging
// schemas and roles (catalog_api_readonly, publisher_import_writer,
// ...) that api-feed/api-search/api-commerce/api-identity's own
// *_role.sql migrations grant against — see runbooks/deploy.md §4.
// The other four don't depend on each other, but running them in
// build-phase order keeps behavior deterministic and matches the
// order the runbook already documents.
const SERVICES: readonly { name: string; migrationsTable: string }[] = [
  { name: "api-catalog", migrationsTable: "pgmigrations" },
  { name: "api-feed", migrationsTable: "pgmigrations_api_feed" },
  { name: "api-search", migrationsTable: "pgmigrations_api_search" },
  { name: "api-commerce", migrationsTable: "pgmigrations_api_commerce" },
  { name: "api-identity", migrationsTable: "pgmigrations_api_identity" },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export async function handler(event: MigrationRunnerEvent = {}): Promise<RunnerResult> {
  const direction = event.direction ?? "up";
  const { username, password } = await resolveMasterCredential();

  const databaseUrl = {
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT ?? 5432),
    database: requireEnv("PGDATABASE"),
    user: username,
    password,
    // Verification is unconditional (no local-dev/docker-compose path
    // to accommodate, unlike apps/api-catalog's database.module.ts) —
    // `ca` is what makes that verification actually succeed against
    // RDS's own certificate; see RDS_CA_BUNDLE's comment above.
    ssl: { rejectUnauthorized: true, ca: RDS_CA_BUNDLE },
  };

  // down runs in reverse so each service's own foreign-key/role
  // dependencies unwind in the opposite order they were created.
  const services = direction === "down" ? [...SERVICES].reverse() : SERVICES;

  const results: ServiceResult[] = [];
  for (const service of services) {
    console.log(`==> Running ${direction} migrations for ${service.name}`);
    try {
      const migrations = await runner({
        databaseUrl,
        // __dirname at runtime is dist-lambda.zip's "dist/src" (tsconfig's
        // rootDir "." preserves the src/ prefix, matching every other
        // service's "dist/src/<entry>.handler" Lambda handler string) —
        // two levels up reaches the zip root, where package-lambda.sh
        // copies each service's migrations/ directory alongside dist/.
        dir: path.join(__dirname, "..", "..", "migrations", service.name),
        migrationsTable: service.migrationsTable,
        direction,
      });
      console.log(`==> ${service.name}: ${migrations.length} migration(s) applied`);
      results.push({ service: service.name, migrationsRun: migrations.map((m) => m.name) });
    } catch (error) {
      console.error(`==> ${service.name} migration failed — stopping (remaining services not attempted)`);
      throw error;
    }
  }

  // Stored-password roles (directus_app/medusa_app, and — since RDS
  // Proxy IAM auth was abandoned for them — catalog_api_readonly/
  // feed_api_rw/search_api_readonly/commerce_api_rw/identity_api_rw/
  // publisher_import_writer) need their real Postgres password kept in
  // sync with Secrets Manager; nothing else does this, and a plain SQL
  // migration never could without leaking the value into git. Only on
  // "up" — a "down" migration run is reverting schema, not rotating
  // credentials.
  const rolePasswordsSynced = direction === "up" ? await syncRolePasswords(databaseUrl) : [];
  if (rolePasswordsSynced.length > 0) {
    console.log(`==> Synced passwords for: ${rolePasswordsSynced.join(", ")}`);
  }

  const publishers = await fetchPublishers(databaseUrl);
  console.log(`==> catalog.publishers: ${JSON.stringify(publishers)}`);

  return { services: results, publishers, rolePasswordsSynced };
}

// Separate connection from runner()'s own (node-pg-migrate opens and
// closes its own client internally per call, not something this can
// reuse) — same databaseUrl, so the same master credential and CA
// bundle apply.
async function fetchPublishers(databaseUrl: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: { rejectUnauthorized: boolean; ca: string };
}): Promise<PublisherRow[]> {
  const client = new Client(databaseUrl);
  await client.connect();
  try {
    const { rows } = await client.query<PublisherRow>("SELECT id, code, name FROM catalog.publishers ORDER BY created_at");
    return rows;
  } finally {
    await client.end();
  }
}
