import { Injectable, Logger } from "@nestjs/common";

// Spec's "Failure handling / LLM" section: failure threshold 3,
// cooldown 30s, half-open single trial after cooldown. Lives in this
// Lambda, not the EC2 AI service, per spec's explicit "Circuit breaker
// lives in Lambda (not EC2)".
//
// State is a plain in-memory singleton (NestJS-scoped, one instance per
// warm Lambda execution environment) — NOT shared across concurrent
// Lambda execution environments, and reset to CLOSED on every cold
// start. Spec doesn't call for a shared store (DynamoDB, etc.), and
// this feature is explicitly framed as "low-traffic, experimental" —
// at that volume, concurrent execution environments are rare enough
// that per-instance state is an acceptable simplification. If traffic
// grows, promoting this to a small DynamoDB-backed store is a
// contained follow-up (this class's public interface wouldn't need to
// change, only its internals).
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

@Injectable()
export class CircuitBreaker {
  private readonly logger = new Logger(CircuitBreaker.name);

  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private cooldownUntil = 0;

  /** Call before attempting the AI service request. */
  canAttempt(): boolean {
    if (this.state === "OPEN") {
      if (Date.now() >= this.cooldownUntil) {
        // Cooldown elapsed — allow exactly one trial request through.
        this.state = "HALF_OPEN";
        this.logger.log("circuit breaker: OPEN -> HALF_OPEN (cooldown elapsed, allowing one trial)");
        return true;
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.state !== "CLOSED") {
      this.logger.log(`circuit breaker: ${this.state} -> CLOSED (trial succeeded)`);
    }
    this.state = "CLOSED";
    this.failureCount = 0;
  }

  recordFailure(): void {
    if (this.state === "HALF_OPEN") {
      // The one trial request failed — back to OPEN for another full cooldown.
      this.open();
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= FAILURE_THRESHOLD) {
      this.open();
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  private open(): void {
    this.state = "OPEN";
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    this.failureCount = 0;
    this.logger.warn(`circuit breaker: OPEN for ${COOLDOWN_MS}ms`);
  }
}
