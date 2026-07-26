import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import type { CanonicalBook } from "@pk-literature/adapter-sdk";
import type { CoverUpload, StagingIngestClient, SubmitBookResult } from "./staging-ingest-client";

// Real implementation — signs every request with SigV4 using the
// GitHub Actions OIDC-assumed role's temporary credentials
// (gha-publisher-import-<env>, infrastructure/iam.md), which is how
// API Gateway's AWS_IAM route authorization (ADR-009) verifies the
// caller without this app ever holding a long-lived secret. Credentials
// come from the environment via aws-actions/configure-aws-credentials
// in the workflow (.github/workflows/publisher-import.yml) — this
// class never reads a secret directly, only whatever
// @aws-sdk/credential-provider-node's default chain finds.
export class SigV4HttpStagingIngestClient implements StagingIngestClient {
  private readonly signer: SignatureV4;

  constructor(
    private readonly baseUrl: string,
    private readonly region: string,
  ) {
    this.signer = new SignatureV4({
      service: "execute-api",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }

  async getCursor(publisherId: string): Promise<{ cursor: string | null; lastImportAt: string | null }> {
    return this.request("GET", `/publishers/${publisherId}/cursor`);
  }

  async startImportRun(
    publisherId: string,
    trigger: "scheduled" | "manual" | "retry",
  ): Promise<{ runId: string }> {
    return this.request("POST", `/publishers/${publisherId}/import-runs`, { trigger });
  }

  async submitBook(runId: string, book: CanonicalBook, cover: CoverUpload | null): Promise<SubmitBookResult> {
    return this.request("POST", `/import-runs/${runId}/books`, { book, cover: cover ?? undefined });
  }

  async completeImportRun(
    runId: string,
    status: "completed" | "failed" | "partially_failed",
    cursor: string | null,
    errorSummary: string | null,
  ): Promise<void> {
    await this.request("POST", `/import-runs/${runId}/complete`, {
      status,
      cursor: cursor ?? undefined,
      errorSummary: errorSummary ?? undefined,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // NOT `new URL(path, this.baseUrl)`: WHATWG URL resolution treats an
    // absolute-path second argument (path starts with "/") as replacing
    // the base's own path entirely, silently dropping baseUrl's "/v1"
    // — every request was actually hitting `${origin}${path}` with no
    // "/v1" prefix at all, matching none of the registered API Gateway
    // route keys (which all include "/v1/" literally). Plain
    // concatenation, same as apps/web/src/lib/api/server-fetch.ts's
    // established `${API_BASE_URL}${path}` pattern, avoids that.
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`);
    const bodyText = body !== undefined ? JSON.stringify(body) : undefined;

    const httpRequest = new HttpRequest({
      method,
      protocol: url.protocol,
      hostname: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      path: url.pathname + url.search,
      headers: {
        host: url.hostname,
        ...(bodyText ? { "content-type": "application/json" } : {}),
      },
      ...(bodyText !== undefined ? { body: bodyText } : {}),
    });

    const signed = await this.signer.sign(httpRequest);

    const response = await fetch(url, {
      method: signed.method,
      headers: signed.headers as Record<string, string>,
      ...(typeof signed.body === "string" ? { body: signed.body } : {}),
    });

    if (!response.ok) {
      throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as T;
  }
}
