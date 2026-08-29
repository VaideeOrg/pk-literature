import type { ColumnType, Generated } from "kysely";

// Hand-written against plan/database/ddl/staging.sql + the subset of
// catalog.sql this service actually touches — see database/migrations.md:
// DDL is the source of truth. Same CamelCasePlugin convention as
// apps/api-catalog/src/database/database.types.ts (declared in
// camelCase, translated to snake_case SQL columns both directions).
//
// This service reads `catalog` (for duplicate detection against
// existing books, and the publisher's own last_import_cursor) but only
// ever writes `staging` plus the two cursor columns on
// catalog.publishers — enforced at the DB-role level, not just here
// (migration 20260101000007_publisher_import_writer_role.sql). Only
// the columns this service actually reads/writes are typed below, not
// full mirrors of every column on catalog.books/publishers.

export type ImportRunStatus = "running" | "completed" | "failed" | "partially_failed";
export type StagingBookStatus = "pending_validation" | "needs_review" | "approved" | "rejected" | "promoted";
export type MediaStatus = "pending" | "downloaded" | "virus_scanned" | "optimized" | "uploaded" | "failed";
export type ValidationSeverity = "warning" | "error";

export interface ImportRunTable {
  id: Generated<string>;
  publisherId: string;
  trigger: string;
  status: ImportRunStatus;
  startedAt: Generated<ColumnType<Date, never, never>>;
  completedAt: Date | null;
  totalBooks: Generated<number>;
  newBooks: Generated<number>;
  updatedBooks: Generated<number>;
  rejectedBooks: Generated<number>;
  errorSummary: string | null;
}

export interface StagingBookTable {
  id: Generated<string>;
  importRunId: string;
  publisherId: string;
  sourceRef: string;
  rawPayload: unknown;
  isbn13: string | null;
  title: string | null;
  subtitle: string | null;
  authorNames: string[] | null;
  publisherName: string | null;
  description: string | null;
  language: string | null;
  coverSourceUrl: string | null;
  // Write-through'd from staging.staging_media.s3_key whenever
  // storeCover() succeeds - see migration
  // 20260101000022_staging_books_cover_s3_key.sql for why this
  // denormalized copy exists instead of Directus reaching into the
  // related staging_media row directly.
  coverS3Key: string | null;
  price: string | null; // numeric(10,2) — returned as string, same reasoning as api-catalog's InventoryTable.price
  currency: string | null;
  stock: number | null;
  category: string | null;
  publicationDate: ColumnType<string, string | null, string | null> | null;
  editionLabel: string | null;
  pageCount: number | null;
  matchedWorkId: string | null;
  matchedBookId: string | null;
  matchConfidence: string | null; // numeric(4,3)
  status: StagingBookStatus;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewDecisionNotes: string | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
  updatedAt: Generated<ColumnType<Date, never, never>>;
}

export interface StagingInventoryTable {
  id: Generated<string>;
  stagingBookId: string;
  sku: string | null;
  stock: number | null;
  price: string | null;
  currency: string | null;
  availability: string | null;
  capturedAt: Generated<ColumnType<Date, never, never>>;
}

export interface StagingMediaTable {
  id: Generated<string>;
  stagingBookId: string;
  sourceUrl: string;
  status: MediaStatus;
  s3Key: string | null;
  checksumSha256: string | null;
  failureReason: string | null;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface StagingValidationTable {
  id: Generated<string>;
  stagingBookId: string;
  severity: ValidationSeverity;
  code: string;
  message: string;
  createdAt: Generated<ColumnType<Date, never, never>>;
}

export interface PublisherCursorTable {
  id: string;
  name: string;
  code: string;
  lastImportCursor: string | null;
  lastImportAt: Date | null;
}

// Duplicate-detection read model — only the columns needed to compute
// an ISBN/title match, not a full mirror of catalog.books.
export interface CatalogBookForMatchingTable {
  id: string;
  workId: string;
  isbn13: string | null;
  title: string;
}

export interface Database {
  "staging.importRuns": ImportRunTable;
  "staging.stagingBooks": StagingBookTable;
  "staging.stagingInventory": StagingInventoryTable;
  "staging.stagingMedia": StagingMediaTable;
  "staging.stagingValidation": StagingValidationTable;
  "catalog.publishers": PublisherCursorTable;
  "catalog.books": CatalogBookForMatchingTable;
}
