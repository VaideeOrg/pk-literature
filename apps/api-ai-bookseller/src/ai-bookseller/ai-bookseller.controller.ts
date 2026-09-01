import { BadRequestException, Body, Controller, Get, Post, UploadedFile, UseInterceptors } from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { GetAiHealthResponse, PostAiAsrResponse, PostAiChatResponse } from "@pk-literature/contracts";
import { AiBooksellerService } from "./ai-bookseller.service";
import { PostChatDto } from "./dto/post-chat.dto";

@Controller("ai")
export class AiBooksellerController {
  constructor(private readonly aiBookseller: AiBooksellerService) {}

  @Post("chat")
  async chat(@Body() dto: PostChatDto): Promise<PostAiChatResponse> {
    if (!this.aiBookseller.isFeatureEnabled()) {
      return { response: null, conversationId: dto.conversationId, fallback: true, latencyMs: 0, errorCode: "FEATURE_DISABLED" };
    }
    return this.aiBookseller.chat(dto);
  }

  // multipart/form-data, field name "audio" — per spec's ASR API
  // ("POST /asr — multipart audio, WAV and common browser formats").
  //
  // NOT independently verified against a live deployment: binary
  // multipart passthrough through API Gateway HTTP API (payload format
  // 2.0) -> Lambda proxy integration -> @codegenie/serverless-express ->
  // multer needs API Gateway's binary media type handling configured
  // correctly (isBase64Encoded on the incoming event) for the bytes to
  // arrive intact rather than corrupted by a UTF-8 reinterpretation —
  // this repo's own convention (see apps/directus/scripts/bootstrap.ts's
  // header) is to flag exactly this kind of sandbox-unverifiable risk
  // rather than claim confidence it hasn't earned. Confirm with a real
  // multipart POST against the deployed endpoint before relying on this
  // path; terraform/modules/api-gateway may need an explicit
  // binary_media_types entry if the default "*/*" handling doesn't
  // already cover it.
  @Post("asr")
  @UseInterceptors(FileInterceptor("audio"))
  async asr(@UploadedFile() file: Express.Multer.File): Promise<PostAiAsrResponse> {
    if (!this.aiBookseller.isFeatureEnabled()) {
      return { text: null, fallback: true, errorCode: "FEATURE_DISABLED" };
    }
    if (!file) {
      throw new BadRequestException('Missing "audio" file field');
    }
    return this.aiBookseller.asr(file.buffer, file.mimetype);
  }

  @Get("health")
  async health(): Promise<GetAiHealthResponse> {
    return this.aiBookseller.health();
  }
}
