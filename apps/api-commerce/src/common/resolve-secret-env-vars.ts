import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

/**
 * secrets.md: "Nothing is ever passed as a plain Lambda/ECS environment
 * variable — environment variables hold the Secrets Manager ARN, the
 * runtime resolves it at cold start." terraform/environments/<env>/
 * api-commerce.tf sets RAZORPAY_KEY_ID_SECRET_ARN /
 * RAZORPAY_KEY_SECRET_SECRET_ARN / RAZORPAY_WEBHOOK_SECRET_SECRET_ARN;
 * this resolves each into the plain env var razorpay.client.ts and
 * payments.controller.ts already read (RAZORPAY_KEY_ID etc.), once per
 * cold start, before the Nest app is built.
 *
 * A no-op locally / in tests, where the *_SECRET_ARN vars are unset and
 * .env.example's plain RAZORPAY_* vars (if any) are used directly.
 */
const SECRET_ARN_ENV_VARS: Record<string, string> = {
  RAZORPAY_KEY_ID: "RAZORPAY_KEY_ID_SECRET_ARN",
  RAZORPAY_KEY_SECRET: "RAZORPAY_KEY_SECRET_SECRET_ARN",
  RAZORPAY_WEBHOOK_SECRET: "RAZORPAY_WEBHOOK_SECRET_SECRET_ARN",
  // Read by inventory-sync-handler.ts, not src/lambda.ts's own HTTP
  // handler - included here anyway since both entry points share this
  // one resolver rather than each maintaining its own copy.
  INVENTORY_WEBHOOK_SECRET: "INVENTORY_WEBHOOK_SECRET_SECRET_ARN",
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
