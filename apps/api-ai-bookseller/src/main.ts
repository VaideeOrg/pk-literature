import { createApp } from "./create-app";

// Local dev entry point only — apps/api-ai-bookseller runs as a Lambda
// in every deployed environment (src/lambda.ts). `pnpm start:dev` here
// against a locally-run ai-service (docker-compose up in ai-service/,
// AI_SERVICE_BASE_URL pointed at it).
async function bootstrap(): Promise<void> {
  const app = await createApp();
  const port = process.env.PORT ?? 3006;
  await app.listen(port);
  console.log(`api-ai-bookseller listening on :${port}`);
}

void bootstrap();
