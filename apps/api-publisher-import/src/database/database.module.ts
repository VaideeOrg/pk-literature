import { Global, Module, type Provider } from "@nestjs/common";
import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Database } from "./database.types";

// Identical shape to apps/api-catalog/src/database/database.module.ts —
// see that file's comments for the IAM-vs-password auth reasoning.
// Duplicated rather than shared (development/repository-layout.md: no
// shared query-layer package, each service owns its own DB module) —
// same convention already established for database.types.ts.
export const KYSELY = Symbol("KYSELY");

let cachedPassword: string | undefined;

function resolvePassword(): string | (() => Promise<string>) {
  if (process.env.DB_AUTH_MODE === "iam") {
    const signer = new Signer({
      hostname: requireEnv("PGHOST"),
      port: Number(process.env.PGPORT ?? 5432),
      username: requireEnv("PGUSER"),
      region: requireEnv("AWS_REGION"),
    });

    return () => signer.getAuthToken();
  }

  const secretArn = process.env.DB_PASSWORD_SECRET_ARN;
  if (!secretArn) {
    return process.env.PGPASSWORD ?? "";
  }

  return async () => {
    if (cachedPassword === undefined) {
      const client = new SecretsManagerClient({});
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (!result.SecretString) {
        throw new Error(`Secret ${secretArn} has no SecretString`);
      }
      cachedPassword = (JSON.parse(result.SecretString) as { password: string }).password;
    }
    return cachedPassword;
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const kyselyProvider: Provider = {
  provide: KYSELY,
  useFactory: () => {
    const pool = new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: resolvePassword(),
      ssl:
        process.env.PGSSL === "disable"
          ? undefined
          : { rejectUnauthorized: process.env.NODE_ENV === "production" },
      max: 5,
    });

    return new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    });
  },
};

@Global()
@Module({
  providers: [kyselyProvider],
  exports: [KYSELY],
})
export class DatabaseModule {}
