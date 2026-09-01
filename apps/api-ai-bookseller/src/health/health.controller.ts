import { Controller, Get } from "@nestjs/common";

// Operational endpoint for API Gateway/load-balancer-style health
// checks — same purpose as apps/api-feed/src/health/health.controller.ts.
// Deliberately separate from GET /v1/ai/health (ai-bookseller.controller.ts),
// which reports the *AI service's* (EC2) health, not this Lambda's own.
@Controller("health")
export class HealthController {
  @Get()
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
