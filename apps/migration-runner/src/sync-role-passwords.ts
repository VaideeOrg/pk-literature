import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";

// Every stored-password DB role (directus_app/medusa_app, plus — since
// switching the six Lambda services' own roles off RDS Proxy IAM auth
// back to a stored password — catalog_api_readonly/feed_api_rw/
// search_api_readonly/commerce_api_rw/identity_api_rw/
// publisher_import_writer) needs its real Postgres password kept in
// sync with whatever random value Terraform generated into its own
// Secrets Manager secret. `CREATE ROLE ... WITH LOGIN` alone never
// sets a password — nothing did this before, which is a real,
// pre-existing gap (directus_app/medusa_app's migrations never set one
// either) that only became visible once a role actually needed to
// authenticate this way for real.
//
// ROLE_PASSWORD_SECRET_ARNS is a JSON-encoded { roleName: secretArn }
// map (terraform/environments/<env>/migration-runner.tf) — done here,
// against the master connection this Lambda already holds, rather
// than as a checked-in SQL migration, since a migration file can never
// contain the actual password value without leaking it into git.
//
// Secret value shapes differ by role: the six former-IAM-auth roles'
// secrets are jsonencode({ username, password }) (matching
// rds_master's own shape); directus_app/medusa_app's are a bare
// password string (ECS task-definition `secrets` injects that value
// directly into an env var, so it can't be JSON). Handle both.
function extractPassword(secretString: string): string {
  try {
    const parsed = JSON.parse(secretString) as { password?: string };
    if (typeof parsed.password === "string") return parsed.password;
  } catch {
    // Not JSON — fall through to treating it as the bare password.
  }
  return secretString;
}

export async function syncRolePasswords(masterConnection: {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: { rejectUnauthorized: boolean; ca?: string };
}): Promise<string[]> {
  const raw = process.env.ROLE_PASSWORD_SECRET_ARNS;
  if (!raw) return [];
  const roleSecretArns = JSON.parse(raw) as Record<string, string>;

  const secretsClient = new SecretsManagerClient({});
  const client = new Client(masterConnection);
  await client.connect();
  try {
    const synced: string[] = [];
    for (const [role, secretArn] of Object.entries(roleSecretArns)) {
      const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (!result.SecretString) {
        throw new Error(`Secret for role ${role} (${secretArn}) has no SecretString`);
      }
      const password = extractPassword(result.SecretString);
      // Role names come from our own Terraform config, never user
      // input — safe to interpolate directly; ALTER ROLE doesn't
      // support parameterized identifiers anyway.
      await client.query(`ALTER ROLE ${role} WITH PASSWORD '${password.replace(/'/g, "''")}'`);
      synced.push(role);
    }
    return synced;
  } finally {
    await client.end();
  }
}
