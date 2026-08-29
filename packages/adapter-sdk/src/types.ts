import { z } from "zod";

// Canonical Book Model (SPEC-04 Appendix A) — the shape every adapter's
// normalize() step produces, regardless of source format (HTML/REST/
// GraphQL/CSV/JSON feed). Deliberately flat, matching
// staging.staging_books' columns 1:1 (plan/database/ddl/staging.sql) —
// this is what gets POSTed to the staging-ingest API and written
// almost verbatim, not a nested domain-model shape like
// @pk-literature/domain-types' Book (that's the production catalog's
// read shape, a different concern entirely: this one predates
// editorial review and DB ids).
export const CanonicalBookSchema = z.object({
  sourceRef: z.string().min(1), // publisher's own id/URL — staging_books.source_ref
  // Publisher's own internal SKU/product-id, kept separate from isbn13
  // rather than folded into it — a publisher's SKU is not guaranteed to
  // actually be an ISBN even when it looks numeric (Ethirveliyeedu
  // adapter: isbn13 is only ever populated from an explicit "ISBN:"
  // label, never inferred from this). null for adapters with no such
  // concept (e.g. Kalachuvadu).
  sourceSku: z.string().nullable(),
  isbn13: z.string().length(13).nullable(),
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  authorNames: z.array(z.string().min(1)),
  publisherName: z.string().nullable(),
  description: z.string().nullable(),
  language: z.string().length(2).nullable(),
  coverSourceUrl: z.string().url().nullable(),
  price: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  stock: z.number().int().nonnegative().nullable(),
  category: z.string().nullable(),
  publicationDate: z.string().date().nullable(),
  editionLabel: z.string().nullable(),
  pageCount: z.number().int().positive().nullable(),
});
export type CanonicalBook = z.infer<typeof CanonicalBookSchema>;

// discover()'s output — enough to paginate/dedupe/fetch, not full book
// data yet (SPEC-04 §10/§11).
export interface DiscoveredBookRef {
  sourceRef: string;
  sourceUrl: string;
}

export interface DiscoveryResult {
  refs: DiscoveredBookRef[];
  // Opaque adapter-defined cursor for the *next* discovery page — not
  // to be confused with catalog.publishers.last_import_cursor (SPEC-04
  // §21), which is the incremental-import watermark across whole runs.
  // Null once the last page has been reached.
  nextPageCursor: string | null;
}

// fetchBook()/fetchBooks()' raw output — deliberately untyped beyond
// "some JSON-ish payload plus where it came from": every publisher's
// raw shape is different by definition (that's the entire reason
// normalize() exists), so there is nothing more specific to say about
// it at the SDK level. Each adapter's own fetch/normalize pair agrees
// on the real shape internally.
export interface RawBook {
  sourceRef: string;
  sourceUrl: string;
  raw: unknown;
}

export interface RawInventory {
  sourceRef: string;
  stock: number | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
}

export interface DownloadedCover {
  sourceUrl: string;
  contentType: string;
  bytes: Buffer;
  widthPx: number | null;
  heightPx: number | null;
}

export type ValidationSeverity = "warning" | "error";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
}

export interface ValidationResult {
  issues: ValidationIssue[];
  hasErrors: boolean;
}

// SPEC-04 §6 — every adapter implements this. §7 lists the adapter
// *types* (HTML/REST/GraphQL/CSV/JSON feed); this interface is the
// same regardless of which type a given publisher needs, matching
// ADR-009's split: everything here runs on a GitHub Actions runner
// (discover/fetchBooks/fetchBook/fetchInventory/downloadCover/
// normalize), except validate() — declared here for interface
// completeness (SPEC-04 §6 lists it as part of the adapter contract),
// but only its field-level, DB-independent checks
// (validateBookFields() in validate.ts) are meant to run adapter-side,
// as a cheap fail-fast before ever POSTing to AWS. The authoritative
// validation — including duplicate detection, which needs the
// database — happens in apps/api-publisher-import's staging-ingest
// Lambda, not here (ADR-009).
export interface PublisherAdapter {
  readonly publisherCode: string;

  discover(cursor: string | null): Promise<DiscoveryResult>;
  fetchBooks(refs: DiscoveredBookRef[]): Promise<RawBook[]>;
  fetchBook(ref: DiscoveredBookRef): Promise<RawBook>;
  fetchInventory(ref: DiscoveredBookRef): Promise<RawInventory>;
  downloadCover(sourceUrl: string): Promise<DownloadedCover>;
  normalize(raw: RawBook): CanonicalBook;
  validate(book: CanonicalBook): ValidationResult;
}
