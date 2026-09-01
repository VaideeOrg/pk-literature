# api-ai-bookseller

Thin Lambda proxy for the AI Tamil Bookseller feature (see
`/ai-service/README.md` for the actual LLM/ASR EC2 host this talks to).

```
Frontend (/feed page) -> API Gateway -> this Lambda -> EC2 ai-service (private HTTP)
```

This service deliberately does **not**:
- Connect to Postgres/RDS Proxy (no DatabaseModule) — book context is
  passed through from the frontend as-is, never re-fetched from
  Directus/catalog.
- Perform any LLM inference or ASR itself — both happen on the EC2 host
  this proxies to (`ai-service/`).
- Persist conversation history — stateless per spec; the frontend holds
  the last 6-8 turns and resends them on every request.

What it does own:
- **Feature flag check** (`FEATURE_AI_BOOKSELLER`) — short-circuits with
  a `fallback: true, errorCode: "FEATURE_DISABLED"` response when off,
  matching the same plain-runtime-env-var pattern as
  `terraform/environments/prod/web.tf`'s `COMING_SOON_MODE`.
- **Circuit breaker** (`ai-bookseller/circuit-breaker.ts`) — 3-failure
  threshold, 30s cooldown, single half-open trial after. In-memory only
  (see that file's header comment for the tradeoff this accepts, given
  the feature's "low-traffic, experimental" framing).
- **Request validation** (`PostChatDto`).
- **AI service invocation** with an 8s timeout + 1 retry for `/chat`,
  10s timeout for `/asr` (spec's stated limits).
- **Response formatting** into the shared `PostAiChatResponse`/`PostAiAsrResponse`
  contracts (`packages/contracts/src/ai-bookseller-api.ts`).
- **Usage event logging** — one structured CloudWatch log line per chat
  request (`timestamp`, `conversationId`, `bookId`, `success`), never
  raw audio or full conversation text.

## Local dev

```bash
pnpm install
cp .env.example .env.local
pnpm start:dev
```

Point `AI_SERVICE_BASE_URL` at a locally-running `ai-service/` (`cd
ai-service && docker-compose up`) or a deployed dev instance.

## Open verification note

`POST /ai/asr`'s multipart file upload (`ai-bookseller.controller.ts`)
has not been round-tripped against a real deployed API
Gateway/Lambda — see that endpoint's own header comment for the
specific risk (binary passthrough through API Gateway's payload
format 2.0 proxy integration). Verify with a real multipart POST
against the deployed endpoint before relying on it.
