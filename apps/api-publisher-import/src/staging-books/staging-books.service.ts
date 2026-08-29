import { Inject, Injectable } from "@nestjs/common";
import { sql, type Kysely } from "kysely";
import { validateBookFields, type CanonicalBook, type ValidationIssue } from "@pk-literature/adapter-sdk";
import type { BookImportedEvent, ImportRejectedEvent } from "@pk-literature/contracts";
import { KYSELY } from "../database/database.module";
import type { Database } from "../database/database.types";
import { NotFoundProblem } from "../common/problem-details.exception";
import { EventBridgeService } from "../common/eventbridge.service";
import { MediaStorageService } from "../common/media-storage.service";
import type { CoverUploadDto, SubmitStagingBookDto } from "./dto/submit-staging-book.dto";

export interface SubmitResult {
  stagingBookId: string;
  status: string;
  issues: ValidationIssue[];
}

// No jest unit test for submit() below — the existing fluent Kysely
// mock (test/kysely-mock.ts) only covers read-query chains
// (selectFrom/where/execute...), and this method's interesting
// behavior lives in write-path specifics a shallow mock can't exercise
// meaningfully: the ON CONFLICT upsert, the `xmax = 0` new-vs-updated
// detection, and the pg_trgm `sql` tagged-template fuzzy-match query.
// Deep-mocking those would mostly test the mock, not this code.
// Instead this was validated for real, directly against a local
// Postgres with the existing catalog fixture data (a "kalachuvadu"
// publisher and a "Ponniyin Selvan Part 1" book): exact-title fuzzy
// match correctly surfaced as a warning (not a rejection), a genuinely
// new book inserted cleanly with newBooks incrementing, resubmitting
// the same sourceRef correctly went through the update branch with
// updatedBooks incrementing (not newBooks), a book missing every
// required field correctly landed as `rejected` with all six
// required-field errors plus both warnings present, and the run's
// counters (totalBooks/newBooks/updatedBooks/rejectedBooks) matched in
// every case. ImportRunsService.complete()'s cursor write-back was
// verified the same way. Not repeatable via `pnpm test` — there's no
// CI-provisioned Postgres for this app yet — but the logic ran for
// real, not just against a mock.
//
// The re-crawl guard's ON CONFLICT ... WHERE below was the same story
// once, and shipped with a real bug from it: an unqualified `.where
// ("status", ...)` compiled to ambiguous SQL (both the conflicting row
// and `excluded` expose a `status` column), which only surfaced live
// against production data — a local Postgres run of this same upsert,
// before the fix, reproduces the exact "column reference \"status\" is
// ambiguous" error a real publisher-import run hit. All four cases
// (fresh insert, a rejected row updating through, and both protected
// statuses correctly no-op'ing without touching the row) were
// re-verified against a real Postgres after the eb.ref('staging.
// stagingBooks.status') fix.

@Injectable()
export class StagingBooksService {
  // Statuses a re-crawl must never regress. approved/merged both
  // represent a human decision (or, for merged, its already-applied
  // result) - editorial state this pipeline should never silently
  // overwrite just because a publisher's page changed since the last
  // crawl. Deliberately excludes 'needs_review': submit() itself never
  // writes that status (only an editor sets it by hand in Directus),
  // so protecting it too is a separate product decision, not bundled
  // into this fix.
  private static readonly PROTECTED_STATUSES = ["approved", "merged"] as const;

  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly events: EventBridgeService,
    private readonly mediaStorage: MediaStorageService,
  ) {}

  async submit(runId: string, dto: SubmitStagingBookDto): Promise<SubmitResult> {
    const run = await this.db
      .selectFrom("staging.importRuns")
      .select(["id", "publisherId"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run) throw new NotFoundProblem("ImportRun", runId);

    const book = dto.book as unknown as CanonicalBook;
    const fieldResult = validateBookFields(book);
    const { matchedWorkId, matchedBookId, matchConfidence, duplicateIssue } = await this.detectDuplicate(book);

    const issues = duplicateIssue ? [...fieldResult.issues, duplicateIssue] : fieldResult.issues;
    const hasErrors = issues.some((issue) => issue.severity === "error");
    const status = hasErrors ? "rejected" : "pending_validation";

    const stagingBook = await this.db
      .insertInto("staging.stagingBooks")
      .values({
        importRunId: runId,
        publisherId: run.publisherId,
        sourceRef: book.sourceRef,
        rawPayload: JSON.stringify(book),
        isbn13: book.isbn13,
        title: book.title,
        subtitle: book.subtitle,
        authorNames: book.authorNames,
        publisherName: book.publisherName,
        description: book.description,
        language: book.language,
        coverSourceUrl: book.coverSourceUrl,
        price: book.price !== null ? String(book.price) : null,
        currency: book.currency,
        stock: book.stock,
        category: book.category,
        publicationDate: book.publicationDate,
        editionLabel: book.editionLabel,
        pageCount: book.pageCount,
        matchedWorkId,
        matchedBookId,
        matchConfidence: matchConfidence !== null ? String(matchConfidence) : null,
        status,
      })
      .onConflict((oc) =>
        oc.columns(["publisherId", "sourceRef"]).doUpdateSet((eb) => ({
          rawPayload: eb.ref("excluded.rawPayload"),
          isbn13: eb.ref("excluded.isbn13"),
          title: eb.ref("excluded.title"),
          subtitle: eb.ref("excluded.subtitle"),
          authorNames: eb.ref("excluded.authorNames"),
          publisherName: eb.ref("excluded.publisherName"),
          description: eb.ref("excluded.description"),
          language: eb.ref("excluded.language"),
          coverSourceUrl: eb.ref("excluded.coverSourceUrl"),
          price: eb.ref("excluded.price"),
          currency: eb.ref("excluded.currency"),
          stock: eb.ref("excluded.stock"),
          category: eb.ref("excluded.category"),
          publicationDate: eb.ref("excluded.publicationDate"),
          editionLabel: eb.ref("excluded.editionLabel"),
          pageCount: eb.ref("excluded.pageCount"),
          matchedWorkId: eb.ref("excluded.matchedWorkId"),
          matchedBookId: eb.ref("excluded.matchedBookId"),
          matchConfidence: eb.ref("excluded.matchConfidence"),
          status: eb.ref("excluded.status"),
        }))
        // A re-crawl must never regress an already-approved/merged
        // book. This WHERE is evaluated against the pre-existing row
        // (Postgres's own DO UPDATE ... WHERE semantics - it has access
        // to both the conflicting row and `excluded`): for a protected
        // row it's false, which turns the whole conflict branch into a
        // no-op - no row updated, none returned - rather than silently
        // overwriting its status *and* content with a fresh crawl
        // snapshot that could never reach the catalog anyway
        // (promote-staging-book's idempotency guard keys off
        // promoted_book_id, not status, so even a re-approval here
        // would just no-op instead of re-promoting the updated data).
        //
        // MUST be qualified as `staging.stagingBooks.status`, not a
        // bare "status" - confirmed live (a real production import crash,
        // "column reference \"status\" is ambiguous") and reproduced
        // against a real Postgres: both the conflicting row and
        // `excluded` expose a `status` column at this point, so an
        // unqualified reference is genuinely ambiguous SQL, not
        // resolved to "the conflicting row" the way a plain UPDATE's
        // WHERE would. eb.ref (not the string-overload .where() used
        // everywhere else in this file) is what lets a table name be
        // attached here at all.
        .where((eb) => eb(eb.ref("staging.stagingBooks.status"), "not in", StagingBooksService.PROTECTED_STATUSES)),
      )
      // xmax = 0 is the standard Postgres tell for "this row was
      // inserted by this statement," not updated via the ON CONFLICT
      // branch — used below to credit newBooks vs updatedBooks
      // accurately instead of assuming every submission is new.
      .returning(["id", sql<boolean>`xmax = 0`.as("wasInserted")])
      .executeTakeFirst();

    if (!stagingBook) {
      // The WHERE guard above skipped the update: this (publisherId,
      // sourceRef) already exists and is approved/merged. Look up its
      // current id/status instead of treating this as a fresh
      // submission - no staging_inventory/staging_validation/media
      // rows, no run counters, no event for a resubmission that was
      // explicitly declined.
      const existing = await this.db
        .selectFrom("staging.stagingBooks")
        .select(["id", "status"])
        .where("publisherId", "=", run.publisherId)
        .where("sourceRef", "=", book.sourceRef)
        .executeTakeFirstOrThrow();
      return { stagingBookId: existing.id, status: existing.status, issues: [] };
    }

    if (book.stock !== null || book.price !== null) {
      await this.db
        .insertInto("staging.stagingInventory")
        .values({
          stagingBookId: stagingBook.id,
          stock: book.stock,
          price: book.price !== null ? String(book.price) : null,
          currency: book.currency,
        })
        .execute();
    }

    if (issues.length > 0) {
      await this.db
        .insertInto("staging.stagingValidation")
        .values(issues.map((issue) => ({ stagingBookId: stagingBook.id, ...issue })))
        .execute();
    }

    if (dto.cover) {
      // Write-through, not just an insert into staging_media: Directus
      // can't render a thumbnail on the staging_books browse table from
      // a *related* collection's field (see bootstrap.ts's
      // ensureImageThumbnailDisplays() comment) - cover_s3_key is a
      // denormalized copy kept in sync with whatever the latest
      // successfully-stored cover is, every time this book is
      // (re)submitted with one.
      const { s3Key } = await this.storeCover(stagingBook.id, dto.cover);
      await this.db
        .updateTable("staging.stagingBooks")
        .set({ coverS3Key: s3Key })
        .where("id", "=", stagingBook.id)
        .execute();
    }

    await this.updateRunCounters(runId, status === "rejected", stagingBook.wasInserted);
    await this.emitEvent(stagingBook.id, runId, run.publisherId, book.sourceRef, status, issues);

    return { stagingBookId: stagingBook.id, status, issues };
  }

  private async detectDuplicate(book: CanonicalBook): Promise<{
    matchedWorkId: string | null;
    matchedBookId: string | null;
    matchConfidence: number | null;
    duplicateIssue: ValidationIssue | null;
  }> {
    if (book.isbn13) {
      const match = await this.db
        .selectFrom("catalog.books")
        .select(["id", "workId"])
        .where("isbn13", "=", book.isbn13)
        .executeTakeFirst();
      if (match) {
        return {
          matchedWorkId: match.workId,
          matchedBookId: match.id,
          matchConfidence: 1,
          // SPEC-04 §16: "Errors: Duplicate ISBN" — a hard error, unlike
          // the fuzzy title match below.
          duplicateIssue: { severity: "error", code: "duplicate_isbn", message: `ISBN ${book.isbn13} already exists in the catalog.` },
        };
      }
    }

    if (book.title) {
      // pg_trgm (catalog.sql) — SPEC-04 §15's "Title -> Fuzzy" rule.
      // Informational only (Errors are limited to Duplicate ISBN per
      // §16): surfaces a candidate for the editor to decide on ("Editors
      // decide final action", §15), doesn't block staging on its own.
      const result = await sql<{ id: string; workId: string; score: number }>`
        SELECT id, work_id as "workId", similarity(title, ${book.title}) as score
        FROM catalog.books
        WHERE title % ${book.title}
        ORDER BY score DESC
        LIMIT 1
      `.execute(this.db);
      const match = result.rows[0];
      if (match) {
        return {
          matchedWorkId: match.workId,
          matchedBookId: match.id,
          matchConfidence: match.score,
          duplicateIssue: {
            severity: "warning",
            code: "possible_duplicate_title",
            message: `Title is similar to an existing catalog book (score ${match.score.toFixed(2)}).`,
          },
        };
      }
    }

    return { matchedWorkId: null, matchedBookId: null, matchConfidence: null, duplicateIssue: null };
  }

  private async storeCover(stagingBookId: string, cover: CoverUploadDto): Promise<{ s3Key: string }> {
    const bytes = Buffer.from(cover.bytesBase64, "base64");
    const { s3Key, checksumSha256 } = await this.mediaStorage.storeStagingCover(
      stagingBookId,
      cover.contentType,
      bytes,
    );

    await this.db
      .insertInto("staging.stagingMedia")
      .values({
        stagingBookId,
        sourceUrl: cover.sourceUrl,
        // 'uploaded', not 'downloaded': storeStagingCover() above has
        // already PutObject'd the bytes to S3 by this point - there's no
        // virus-scan/optimize/thumbnail worker in this repo to advance
        // the status any further (media-storage.service.ts's own header
        // comment), so 'uploaded' is the correct terminal status for what
        // this phase actually does. Leaving it at 'downloaded' silently
        // orphaned every cover: promote-staging-book's promoteMedia()
        // only ever looks for status = 'uploaded'.
        status: "uploaded",
        s3Key,
        checksumSha256,
      })
      .execute();

    return { s3Key };
  }

  private async updateRunCounters(runId: string, rejected: boolean, wasInserted: boolean): Promise<void> {
    await this.db
      .updateTable("staging.importRuns")
      .set((eb) => ({
        totalBooks: eb("totalBooks", "+", 1),
        newBooks: wasInserted ? eb("newBooks", "+", 1) : eb.ref("newBooks"),
        updatedBooks: !wasInserted ? eb("updatedBooks", "+", 1) : eb.ref("updatedBooks"),
        rejectedBooks: rejected ? eb("rejectedBooks", "+", 1) : eb.ref("rejectedBooks"),
      }))
      .where("id", "=", runId)
      .execute();
  }

  private async emitEvent(
    stagingBookId: string,
    importRunId: string,
    publisherId: string,
    sourceRef: string,
    status: string,
    issues: ValidationIssue[],
  ): Promise<void> {
    if (status === "rejected") {
      const event: ImportRejectedEvent = {
        stagingBookId,
        importRunId,
        publisherId,
        sourceRef,
        reasons: issues.filter((i) => i.severity === "error").map((i) => i.message),
      };
      await this.events.publish("ImportRejected", event);
      return;
    }

    const event: BookImportedEvent = { stagingBookId, importRunId, publisherId, sourceRef };
    await this.events.publish("BookImported", event);
  }
}
