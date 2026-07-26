import { Global, Module, type Provider } from "@nestjs/common";
import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Database } from "./database.types";

export const KYSELY = Symbol("KYSELY");

// DB_AUTH_MODE=iam mints a fresh IAM auth token per physical connection
// instead of using a stored password. Every deployed environment used
// to run this way through RDS Proxy, but identity_api_rw's own
// pg_hba.conf rule (like every other Lambda service's role here) now
// requires plain password auth instead — RDS Proxy's IAM auth for
// these roles was tried two ways for real and abandoned; see
// terraform/modules/rds-proxy's header comment. `pg`'s Pool accepts a
// password callback specifically so each new connection (not just the
// first) can resolve asynchronously — for IAM this mints a fresh,
// unexpired token (RDS IAM tokens are valid 15 minutes, and a
// long-lived Lambda execution environment can easily outlive that
// between cold starts); for a real stored password it fetches once
// from Secrets Manager and caches for the life of the warm execution
// environment, since unlike a token it never expires.
//
// DB_PASSWORD_SECRET_ARN (deployed environments) fetches the real
// password from Secrets Manager — never a plain env var
// (infrastructure/secrets.md). Bare PGPASSWORD (local dev, via
// docker-compose) is the only path that's an actual plain-text value.
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
      // RDS Proxy requires TLS; local dev (docker-compose) disables it.
      ssl:
        process.env.PGSSL === "disable"
          ? undefined
          : { rejectUnauthorized: process.env.NODE_ENV === "production" },
      max: 5, // small per-invocation pool — RDS Proxy does the real pooling
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
