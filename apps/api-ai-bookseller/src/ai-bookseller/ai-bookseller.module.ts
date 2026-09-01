import { Module } from "@nestjs/common";
import { AiBooksellerController } from "./ai-bookseller.controller";
import { AiBooksellerService } from "./ai-bookseller.service";
import { CircuitBreaker } from "./circuit-breaker";

@Module({
  controllers: [AiBooksellerController],
  providers: [AiBooksellerService, CircuitBreaker],
})
export class AiBooksellerModule {}
