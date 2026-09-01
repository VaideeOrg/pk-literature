import { HttpException } from "@nestjs/common";
import type { ProblemDetails, ProblemType } from "@pk-literature/contracts";
import { PROBLEM_STATUS } from "@pk-literature/contracts";

// Same convention as apps/api-feed/src/common/problem-details.exception.ts
// — used here only for genuine request-validation failures (bad body).
// The AI chat/ASR fallback contract (PostAiChatResponse/PostAiAsrResponse)
// is intentionally its own bespoke shape, not a ProblemDetails — see
// packages/contracts/src/ai-bookseller-api.ts's header comment.
export class ProblemDetailsException extends HttpException {
  constructor(type: ProblemType, detail?: string, instance?: string) {
    const status = PROBLEM_STATUS[type];
    const body: ProblemDetails = { type, title: type, status, detail, instance };
    super(body, status);
  }
}

export class ValidationProblem extends ProblemDetailsException {
  constructor(detail: string) {
    super("ValidationError", detail);
  }
}
