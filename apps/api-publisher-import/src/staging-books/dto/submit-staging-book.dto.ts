import { Type } from "class-transformer";
import {
  IsArray,
  IsBase64,
  IsDateString,
  IsInt,
  IsISO4217CurrencyCode,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  Length,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

// Mirrors @pk-literature/adapter-sdk's CanonicalBookSchema (zod) field
// for field — kept as a class-validator DTO rather than reusing the
// zod schema directly so this endpoint goes through the same global
// ValidationPipe as every other route in this service (coding-
// guidelines.md consistency), at the cost of the two having to be kept
// in sync by hand. If they ever drift, CanonicalBookSchema is the
// source of truth (it's also what the crawler validates against
// before sending).
export class CanonicalBookDto {
  @IsString()
  @MinLength(1)
  sourceRef!: string;

  @IsOptional()
  @IsString()
  sourceSku!: string | null;

  @IsOptional()
  @IsString()
  @Length(13, 13)
  isbn13!: string | null;

  @IsOptional()
  @IsString()
  title!: string | null;

  @IsOptional()
  @IsString()
  subtitle!: string | null;

  @IsArray()
  @IsString({ each: true })
  authorNames!: string[];

  @IsOptional()
  @IsString()
  publisherName!: string | null;

  @IsOptional()
  @IsString()
  description!: string | null;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  language!: string | null;

  @IsOptional()
  @IsUrl()
  coverSourceUrl!: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price!: number | null;

  @IsOptional()
  @IsISO4217CurrencyCode()
  currency!: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  stock!: number | null;

  @IsOptional()
  @IsString()
  category!: string | null;

  @IsOptional()
  @IsDateString()
  publicationDate!: string | null;

  @IsOptional()
  @IsString()
  editionLabel!: string | null;

  @IsOptional()
  @IsInt()
  @IsPositive()
  pageCount!: number | null;
}

// Cover bytes travel through this API rather than being uploaded
// directly to S3 by the crawler — infrastructure/iam.md's
// gha-publisher-import-<env> role deliberately has no S3 access at
// all, only execute-api:Invoke on this one route (ADR-009).
export class CoverUploadDto {
  @IsUrl()
  sourceUrl!: string;

  @IsString()
  contentType!: string;

  @IsBase64()
  bytesBase64!: string;
}

export class SubmitStagingBookDto {
  @ValidateNested()
  @Type(() => CanonicalBookDto)
  book!: CanonicalBookDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CoverUploadDto)
  cover?: CoverUploadDto;
}
