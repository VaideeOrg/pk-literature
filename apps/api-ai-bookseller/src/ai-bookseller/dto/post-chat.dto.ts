import { Type } from "class-transformer";
import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, ValidateNested } from "class-validator";

class BookContextDto {
  @IsString()
  id!: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  author!: string | null;

  @IsOptional()
  @IsString()
  description!: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class ConversationTurnDto {
  @IsIn(["user", "assistant"])
  role!: "user" | "assistant";

  @IsString()
  content!: string;
}

export class PostChatDto {
  @IsString()
  message!: string;

  @ValidateNested()
  @Type(() => BookContextDto)
  book!: BookContextDto;

  @IsUUID()
  conversationId!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConversationTurnDto)
  history?: ConversationTurnDto[];
}
