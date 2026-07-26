import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, urlencoded } from "express";
import { AppModule } from "./app.module";
import { ProblemDetailsFilter } from "./common/problem-details.filter";

// Shared by both entry points (main.ts for local dev, lambda.ts for
// the deployed handler) so they can never drift on global pipes/filters.
export async function createApp(): Promise<NestExpressApplication> {
  // bodyParser: false + our own json()/urlencoded() below, since Nest's
  // default body-parser caps requests at 100kb — a real "PayloadTooLargeError:
  // request entity too large" from a live run (apps/publisher-crawler
  // submits each book's cover as a base64 string in the JSON body,
  // which routinely exceeds that). 6mb matches Lambda's own hard
  // ceiling for synchronous invoke payloads (API Gateway allows up to
  // 10mb, but Lambda itself would reject anything past 6mb before this
  // app ever saw it either way) — no framework-level limit above that
  // number would change anything.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ["error", "warn", "log"],
    bodyParser: false,
  });
  app.use(json({ limit: "6mb" }));
  app.use(urlencoded({ extended: true, limit: "6mb" }));

  app.setGlobalPrefix("v1");
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());

  return app;
}
