import { Injectable, Logger } from "@nestjs/common";
import type {
  AiErrorCode,
  GetAiHealthResponse,
  PostAiAsrResponse,
  PostAiChatResponse,
} from "@pk-literature/contracts";
import { CircuitBreaker } from "./circuit-breaker";
import { PostChatDto } from "./dto/post-chat.dto";

// Spec's fallback line — shown/spoken exactly as written (Tamil, with
// the emoji) whenever the circuit breaker is open or the EC2 AI service
// call itself fails. Never invented per-error-code copy beyond this:
// the spec gives one fallback string, used for every failure mode.
const FALLBACK_RESPONSE =
  "மன்னிக்கவும், இப்போது கொஞ்சம் புத்தகக்கடையில் கூட்டம் அதிகமாகிவிட்டது 😄. சிறிது நேரம் கழித்து மீண்டும் முயற்சி செய்யுங்கள்.";

const LLM_TIMEOUT_MS = 8_000;
const LLM_MAX_RETRY = 1;
const ASR_TIMEOUT_MS = 10_000;
// Spec: "server-side hard limit: a few MB". Enforced here (before the
// request ever reaches the EC2 service) as well as by the AI service
// itself (ai-service/api/server.py) — defense in depth, not redundancy
// for its own sake: this Lambda-side check fails fast without paying
// for a round trip to EC2 first.
const ASR_MAX_BYTES = 5 * 1024 * 1024;

interface AiServiceConfig {
  baseUrl: string;
  authToken: string;
}

@Injectable()
export class AiBooksellerService {
  private readonly logger = new Logger(AiBooksellerService.name);

  constructor(private readonly circuitBreaker: CircuitBreaker) {}

  private getConfig(): AiServiceConfig {
    const baseUrl = process.env.AI_SERVICE_BASE_URL;
    const authToken = process.env.AI_SERVICE_AUTH_TOKEN;
    if (!baseUrl || !authToken) {
      throw new Error("Missing AI_SERVICE_BASE_URL or AI_SERVICE_AUTH_TOKEN env var");
    }
    return { baseUrl, authToken };
  }

  isFeatureEnabled(): boolean {
    // Plain Lambda runtime env var, same convention as
    // terraform/environments/prod/web.tf's COMING_SOON_MODE — a
    // terraform apply toggles it, no redeploy needed. The frontend also
    // gates on its own copy of this flag (apps/web reads it
    // server-side, same COMING_SOON_MODE pattern) so the mic doesn't
    // even render when the feature is off; this check is the
    // server-side backstop for that.
    return process.env.FEATURE_AI_BOOKSELLER === "true";
  }

  async chat(dto: PostChatDto): Promise<PostAiChatResponse> {
    const startedAt = Date.now();

    if (!this.circuitBreaker.canAttempt()) {
      this.logUsageEvent(dto.conversationId, dto.book.id, false);
      return this.fallbackChat(dto.conversationId, "MODEL_UNAVAILABLE", Date.now() - startedAt);
    }

    try {
      const config = this.getConfig();
      const result = await this.callWithRetry(
        () => this.callChatOnce(config, dto),
        LLM_MAX_RETRY,
      );
      this.circuitBreaker.recordSuccess();
      this.logUsageEvent(dto.conversationId, dto.book.id, true);
      return { ...result, latencyMs: Date.now() - startedAt };
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.logger.warn(`chat request failed for conversation ${dto.conversationId}: ${(error as Error).message}`);
      this.logUsageEvent(dto.conversationId, dto.book.id, false);
      return this.fallbackChat(dto.conversationId, "MODEL_UNAVAILABLE", Date.now() - startedAt);
    }
  }

  async asr(audio: Buffer, contentType: string): Promise<PostAiAsrResponse> {
    if (audio.byteLength > ASR_MAX_BYTES) {
      return { text: null, fallback: true, errorCode: "AUDIO_TOO_LARGE" };
    }

    if (!this.circuitBreaker.canAttempt()) {
      return { text: null, fallback: true, errorCode: "ASR_UNAVAILABLE" };
    }

    try {
      const config = this.getConfig();
      const result = await this.callAsrOnce(config, audio, contentType);
      this.circuitBreaker.recordSuccess();
      // Spec: "Never send failed/empty ASR output to the LLM" — enforced
      // by the caller (ai-bookseller.controller.ts never calls chat()
      // with an empty/fallback ASR result), not here.
      return result;
    } catch (error) {
      this.circuitBreaker.recordFailure();
      this.logger.warn(`asr request failed: ${(error as Error).message}`);
      return { text: null, fallback: true, errorCode: "ASR_UNAVAILABLE" };
    }
  }

  async health(): Promise<GetAiHealthResponse> {
    try {
      const config = this.getConfig();
      const response = await fetch(`${config.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${config.authToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json()) as { status: string; model?: string };
      return {
        status: response.ok ? "ok" : "degraded",
        circuitBreaker: this.circuitBreaker.getState(),
        aiService: body,
      };
    } catch {
      return { status: "error", circuitBreaker: this.circuitBreaker.getState() };
    }
  }

  private async callChatOnce(
    config: AiServiceConfig,
    dto: PostChatDto,
  ): Promise<Omit<PostAiChatResponse, "latencyMs">> {
    const response = await fetch(`${config.baseUrl}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${config.authToken}`,
      },
      body: JSON.stringify({
        message: dto.message,
        book: dto.book,
        conversation_id: dto.conversationId,
        history: dto.history ?? [],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`AI service /chat returned ${response.status}`);
    }

    const body = (await response.json()) as { response: string };
    return { response: body.response, conversationId: dto.conversationId, fallback: false };
  }

  private async callAsrOnce(config: AiServiceConfig, audio: Buffer, contentType: string): Promise<PostAiAsrResponse> {
    const formData = new FormData();
    formData.append("audio", new Blob([audio], { type: contentType }), "recording");

    const response = await fetch(`${config.baseUrl}/asr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.authToken}` },
      body: formData,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`AI service /asr returned ${response.status}`);
    }

    const body = (await response.json()) as { text: string | null; fallback: boolean };
    if (body.fallback || !body.text) {
      return { text: null, fallback: true, errorCode: "ASR_UNAVAILABLE" };
    }
    return { text: body.text, fallback: false };
  }

  private async callWithRetry<T>(fn: () => Promise<T>, maxRetry: number): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private fallbackChat(conversationId: string, errorCode: AiErrorCode, latencyMs: number): PostAiChatResponse {
    return {
      response: FALLBACK_RESPONSE,
      conversationId,
      fallback: true,
      latencyMs,
      errorCode,
    };
  }

  /**
   * Spec's "Usage tracking: Minimal event log — timestamp,
   * conversation_id, book_id, success/fallback". Written as a
   * structured CloudWatch log line (this repo's established
   * convention for lightweight event logging — see
   * apps/api-feed/src/feed/feed.service.ts's own usage-event logging),
   * not a database table: nothing else in this service touches
   * Postgres, and standing up a DB connection/migration purely for a
   * handful of log fields isn't worth it for an experimental feature.
   * Never logs raw audio or full conversation text (spec's Security
   * section) — only the fields spec explicitly names.
   */
  private logUsageEvent(conversationId: string, bookId: string, success: boolean): void {
    this.logger.log(
      JSON.stringify({
        event: "ai_bookseller_chat",
        timestamp: new Date().toISOString(),
        conversationId,
        bookId,
        success,
      }),
    );
  }
}
