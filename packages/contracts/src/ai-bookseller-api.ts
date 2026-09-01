// Request/response shapes for the AI Tamil Bookseller feature (spec:
// "AI Tamil Bookseller — Technical Implementation Spec v2"). Public,
// unauthenticated (fully anonymous, no login required) — same posture
// as feed-api.ts's Discovery routes.
//
// Deliberately NOT run through ProblemDetailsException/PROBLEM_STATUS
// like every other service's error path: a fallback response here
// (circuit breaker open, EC2 AI service unreachable, ASR failure) is an
// expected, designed-for outcome the frontend must render gracefully
// (play the fallback line via TTS), not an ad hoc error shape the
// coding-guidelines.md ban is aimed at. Genuine request-validation
// failures (missing message, malformed body) still go through the
// normal ValidationPipe -> ProblemDetailsException path.

// Book context passed through from the already-rendered feed card —
// the Lambda/AI service never re-fetches this from Directus/catalog.
export interface AiBookContext {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  metadata?: Record<string, unknown>;
}

export interface AiConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// POST /ai/chat
export interface PostAiChatRequest {
  message: string;
  book: AiBookContext;
  conversationId: string;
  /** Last 6-8 turns, held and resent by the frontend — server is stateless. */
  history?: AiConversationTurn[];
}

export type AiErrorCode = "MODEL_UNAVAILABLE" | "ASR_UNAVAILABLE" | "AUDIO_TOO_LARGE" | "FEATURE_DISABLED";

export interface PostAiChatResponse {
  response: string | null;
  conversationId: string;
  fallback: boolean;
  latencyMs: number;
  errorCode?: AiErrorCode;
}

// POST /ai/asr — multipart/form-data, field name "audio". See
// apps/api-ai-bookseller/src/ai-bookseller/ai-bookseller.controller.ts
// for the one open verification note on this endpoint (binary
// multipart passthrough through API Gateway HTTP API -> Lambda proxy
// has not been round-tripped against a live deployment).
export interface PostAiAsrResponse {
  text: string | null;
  fallback: boolean;
  errorCode?: AiErrorCode;
}

// GET /ai/health
export interface GetAiHealthResponse {
  status: "ok" | "degraded" | "error";
  circuitBreaker: "CLOSED" | "OPEN" | "HALF_OPEN";
  aiService?: { status: string; model?: string };
}
