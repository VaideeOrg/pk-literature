import { getAdapter } from "./adapters-registry";
import { runImport } from "./run-import";
import { SigV4HttpStagingIngestClient } from "./sigv4-http-staging-ingest-client";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const publisherId = requireEnv("PUBLISHER_ID");
  const publisherCode = requireEnv("PUBLISHER_CODE");
  const publisherBaseUrl = requireEnv("PUBLISHER_BASE_URL");
  const stagingIngestBaseUrl = requireEnv("STAGING_INGEST_BASE_URL");
  const region = requireEnv("AWS_REGION");
  const trigger = (process.env.IMPORT_TRIGGER ?? "scheduled") as "scheduled" | "manual" | "retry";
  // Testing aid (see run-import.ts's RunImportOptions.maxBooks) — unset
  // or "0" means no limit, matching the production default.
  const maxBooksEnv = process.env.MAX_BOOKS;
  const maxBooks = maxBooksEnv && Number(maxBooksEnv) > 0 ? Number(maxBooksEnv) : undefined;

  const adapter = getAdapter(publisherCode, publisherBaseUrl);
  const client = new SigV4HttpStagingIngestClient(stagingIngestBaseUrl, region);

  const summary = await runImport({ publisherId, trigger, adapter, client, ...(maxBooks !== undefined && { maxBooks }) });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));

  if (summary.status === "failed") {
    process.exitCode = 1;
  }
}

void main();
