import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { AiBooksellerModule } from "./ai-bookseller/ai-bookseller.module";

// AI Tamil Bookseller feature — public, unauthenticated (fully
// anonymous by spec, no login required). No DatabaseModule: this
// service never touches Postgres — book context is passed through from
// the frontend, and usage events are logged as structured CloudWatch
// log lines (see ai-bookseller.service.ts), not written to a table.
@Module({
  imports: [AiBooksellerModule],
  controllers: [HealthController],
})
export class AppModule {}
