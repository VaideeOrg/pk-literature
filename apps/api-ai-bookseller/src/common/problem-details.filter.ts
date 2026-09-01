import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Response, Request } from "express";
import type { ProblemDetails } from "@pk-literature/contracts";
import { PROBLEM_STATUS } from "@pk-literature/contracts";
import { ProblemDetailsException } from "./problem-details.exception";

// Identical to apps/api-feed/src/common/problem-details.filter.ts —
// see that file for the full rationale. Only catches genuine request
// errors (validation, unexpected 500s); AiBooksellerController never
// throws for a circuit-breaker-open/AI-service-unreachable condition —
// it returns the spec's fallback body with a 200, so this filter never
// sees those.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof ProblemDetailsException) {
      const body = exception.getResponse() as ProblemDetails;
      response.status(body.status).json({ ...body, instance: request.url });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      const detail =
        typeof responseBody === "string"
          ? responseBody
          : Array.isArray((responseBody as { message?: string[] }).message)
            ? (responseBody as { message: string[] }).message.join("; ")
            : ((responseBody as { message?: string }).message ?? exception.message);

      const body: ProblemDetails = {
        type: status === HttpStatus.BAD_REQUEST ? "ValidationError" : "InternalError",
        title: status === HttpStatus.BAD_REQUEST ? "ValidationError" : "InternalError",
        status: PROBLEM_STATUS[status === HttpStatus.BAD_REQUEST ? "ValidationError" : "InternalError"],
        detail,
        instance: request.url,
      };
      response.status(body.status).json(body);
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    const body: ProblemDetails = {
      type: "InternalError",
      title: "InternalError",
      status: 500,
      instance: request.url,
    };
    response.status(500).json(body);
  }
}
