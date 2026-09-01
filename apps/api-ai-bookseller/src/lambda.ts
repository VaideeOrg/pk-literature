import serverlessExpress from "@codegenie/serverless-express";
import type { Handler } from "aws-lambda";
import { createApp } from "./create-app";
import { resolveSecretEnvVars } from "./common/resolve-secret-env-vars";

// Deployed entry point — API Gateway (HTTP API, payload format v2,
// terraform/modules/api-gateway) invokes this. Public, unauthenticated
// routes (terraform/environments/prod/api-ai-bookseller.tf) — the AI
// Bookseller feature is fully anonymous by spec, same posture as
// api-feed's Discovery routes.
//
// The NestJS app is built once per Lambda execution environment (cold
// start) and reused across warm invocations, same reasoning as
// apps/api-feed/src/lambda.ts — this also means CircuitBreaker's
// in-memory state (see ai-bookseller/circuit-breaker.ts) survives across
// warm invocations of the SAME execution environment only, not globally
// across concurrent ones. Acceptable per spec's "low-traffic,
// experimental feature" framing; see that file's header comment for the
// tradeoff this accepts. AI_SERVICE_AUTH_TOKEN is resolved from its
// Secrets Manager ARN once here too, same convention as
// apps/api-commerce/src/lambda.ts.
let cachedHandler: Handler;

export const handler: Handler = async (event, context, callback) => {
  if (!cachedHandler) {
    await resolveSecretEnvVars();
    const app = await createApp();
    await app.init();
    cachedHandler = serverlessExpress({ app: app.getHttpAdapter().getInstance() });
  }
  return cachedHandler(event, context, callback);
};
