import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * secrets.md: "Nothing is ever passed as a plain Lambda/ECS environment
 * variable — environment variables hold the Secrets Manager ARN, the
 * runtime resolves it at cold start." Same convention and same file
 * shape as apps/api-commerce/src/common/resolve-secret-env-vars.ts.
 * terraform/environments/prod/api-ai-bookseller.tf sets
 * AI_SERVICE_AUTH_TOKEN_SECRET_ARN; this resolves it into the plain
 * AI_SERVICE_AUTH_TOKEN env var ai-bookseller.service.ts reads, once
 * per cold start, before the Nest app is built.
 *
 * A no-op locally / in tests, where AI_SERVICE_AUTH_TOKEN_SECRET_ARN is
 * unset and .env.example's plain AI_SERVICE_AUTH_TOKEN is used directly.
 */
const SECRET_ARN_ENV_VARS: Record<string, string> = {
  AI_SERVICE_AUTH_TOKEN: "AI_SERVICE_AUTH_TOKEN_SECRET_ARN",
};

export async function resolveSecretEnvVars(): Promise<void> {
  const arnEntries = Object.entries(SECRET_ARN_ENV_VARS).filter(([, arnVar]) => process.env[arnVar]);
  if (arnEntries.length === 0) return;

  const client = new SecretsManagerClient({});
  await Promise.all(
    arnEntries.map(async ([targetVar, arnVar]) => {
      const secretId = process.env[arnVar]!;
      const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      if (result.SecretString) {
        process.env[targetVar] = result.SecretString;
      }
    }),
  );
}
