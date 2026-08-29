import type { PublisherAdapter } from "@pk-literature/adapter-sdk";
import { withRetry } from "./retry";
import type { StagingIngestClient } from "./staging-ingest-client";

export interface RunImportOptions {
  publisherId: string;
  trigger: "scheduled" | "manual" | "retry";
  adapter: PublisherAdapter;
  client: StagingIngestClient;
  logger?: Pick<Console, "log" | "warn" | "error">;
  // Caps how many books this run attempts, across all discover() pages —
  // originally added as a testing aid for iterating on an adapter's
  // discover()/normalize() fixes against a handful of real books instead
  // of the whole catalogue, and also a legitimate way to batch a large
  // import across multiple triggered runs: a capped run persists its
  // exact resume point (the adapter's in-progress page cursor, plus how
  // many refs of that page were already processed) to
  // last_import_cursor, so the next run picks up exactly where this one
  // left off - even mid-page, since an adapter's page can be much larger
  // than a typical maxBooks value (see the module-level comment below).
  // Undefined means no limit.
  maxBooks?: number;
}

export interface RunImportSummary {
  runId: string;
  status: "completed" | "failed" | "partially_failed";
  booksProcessed: number;
  booksFailed: number;
}

// The external half of ADR-009's split pipeline: everything here runs
// on a GitHub Actions runner, no AWS access beyond the
// StagingIngestClient's SigV4-signed calls to the one staging-ingest
// API (infrastructure/iam.md's gha-publisher-import-<env> role).
//
// Incremental cursor caveat: this reads/writes
// catalog.publishers.last_import_cursor per SPEC-04 §21's interface
// contract. The persisted value is a JSON-encoded ResumeCursor
// { pageCursor, skip } - pageCursor is the adapter's own opaque
// page-pagination token (a page number for every adapter registered so
// far), skip is how many refs of THAT page were already processed on a
// previous run. Both are needed, not just pageCursor: every adapter
// registered so far pages in chunks of up to 250 (Ethirveliyeedu/
// Yaavarum's `limit=250`), so a maxBooks cap smaller than a page (a very
// realistic batching value - tens, not hundreds) would otherwise cut a
// run short *inside* a page, and re-fetching just that page's own
// cursor on the next run would re-process the exact same refs and hit
// the same cap at the same point forever, never actually progressing.
// `skip` is what lets a resumed run re-fetch that same page (discover()
// has no way to fetch a partial page) but only re-process the refs
// after the ones already submitted last time - already-submitted refs
// are never revisited, and staging_books' UNIQUE(publisher_id,
// source_ref) upsert makes any accidental re-submission harmless
// regardless.
//
// This used to instead persist a bare fabricated
// `new Date().toISOString()`, which no adapter's discover() could parse
// back into a page (`cursor ? Number(cursor) : 1` on an ISO string is
// NaN) - silently breaking the very next run's pagination. last_import_at
// (a separate column, already set automatically by api-publisher-import's
// ImportRunsService.complete() whenever a cursor is persisted) already
// covers "when did we last import"; this file has no reason to
// duplicate that into the cursor column too. A cursor value that fails
// to parse as a ResumeCursor (including a stale fabricated ISO
// timestamp from before this fix) is treated as "start fresh" rather
// than trusted as a page token - see parseResumeCursor().
//
// None of the three adapters registered so far (Kalachuvadu,
// Ethirveliyeedu, Yaavarum) support a real "modified since" filter -
// discover(null) always starts a fresh crawl at page 1. So: a run that
// reaches the true end of the catalogue (nextPageCursor turns null,
// with nothing left unprocessed) correctly persists null, meaning the
// next unlimited run starts over from page 1 - full re-crawls stay
// correct via staging_books' own upsert (ADR-009's own stated
// mitigation). A run cut short by maxBooks instead persists
// { pageCursor, skip } for the in-progress page, so the next run
// resumes exactly where this one left off - this is what makes
// maxBooks usable as a real batching mechanism, not just a testing aid.
// A publisher whose adapter's discover() can accept a real incremental
// filter (a REST/GraphQL/JSON-feed adapter with a "since" parameter,
// SPEC-04 §7) would use pageCursor for that instead; this is disclosed
// here rather than left implicit.
//
// A failed run (see `status` below) never advances the cursor either
// way - by design it is not retried automatically; re-triggering a
// failed run is a deliberate separate action, not something this
// function does on its own.
export async function runImport(options: RunImportOptions): Promise<RunImportSummary> {
  const logger = options.logger ?? console;
  const { publisherId, trigger, adapter, client, maxBooks } = options;

  const { cursor } = await client.getCursor(publisherId);
  const resume = parseResumeCursor(cursor);
  const { runId } = await client.startImportRun(publisherId, trigger);
  logger.log(
    `Started import run ${runId} for publisher ${publisherId} (trigger=${trigger}, cursor=${cursor}` +
      (maxBooks !== undefined ? `, maxBooks=${maxBooks}` : "") +
      `)`,
  );

  let booksProcessed = 0;
  let booksFailed = 0;
  let attempted = 0;
  let pageCursor = resume.pageCursor;
  let sawAnyFailure = false;
  let limitReached = false;
  // How many refs of the *first* page fetched this run to skip - only
  // nonzero when resuming mid-page from a previous maxBooks-limited run;
  // reset to 0 once that page is done, since every later page in this
  // run starts fresh.
  let skipInCurrentPage = resume.skip;
  // What to persist if this run gets cut short mid-page - recomputed
  // every time the limit is actually hit, using pageCursor/consumed as
  // they stand at that exact moment (before pageCursor is reassigned to
  // the next page below).
  let resumeOnLimit: ResumeCursor = resume;

  try {
    pages: do {
      const discovery = await withRetry(() => adapter.discover(pageCursor));
      const refsThisPage = skipInCurrentPage > 0 ? discovery.refs.slice(skipInCurrentPage) : discovery.refs;
      let consumedThisPage = skipInCurrentPage;

      for (const ref of refsThisPage) {
        if (maxBooks !== undefined && attempted >= maxBooks) {
          limitReached = true;
          resumeOnLimit = { pageCursor, skip: consumedThisPage };
          logger.log(`Reached maxBooks=${maxBooks} — stopping this run early (not a failure).`);
          break pages;
        }
        attempted++;
        consumedThisPage++;

        try {
          const raw = await withRetry(() => adapter.fetchBook(ref));
          const book = adapter.normalize(raw);
          const inventory = await withRetry(() => adapter.fetchInventory(ref));
          book.stock = inventory.stock;

          // Cheap fail-fast client-side (ADR-009) — the authoritative
          // check (plus duplicate detection) still happens server-side
          // regardless of this result; this only avoids paying for a
          // cover download on a book that's obviously incomplete.
          const preCheck = adapter.validate(book);
          if (preCheck.hasErrors) {
            logger.warn(`${ref.sourceRef}: failing pre-check, submitting anyway for the authoritative record`, preCheck.issues);
          }

          let cover: { sourceUrl: string; contentType: string; bytesBase64: string } | null = null;
          if (book.coverSourceUrl) {
            const downloaded = await withRetry(() => adapter.downloadCover(book.coverSourceUrl!));
            cover = {
              sourceUrl: downloaded.sourceUrl,
              contentType: downloaded.contentType,
              bytesBase64: downloaded.bytes.toString("base64"),
            };
          }

          const result = await client.submitBook(runId, book, cover);
          booksProcessed++;
          if (result.status === "rejected") {
            booksFailed++;
          }
          logger.log(`${ref.sourceRef}: ${result.status}`);
        } catch (error) {
          booksFailed++;
          sawAnyFailure = true;
          logger.error(`${ref.sourceRef}: failed after retries`, error);
        }
      }

      // Only the first page fetched this run could have a nonzero skip
      // (carried over from a previous run's resume point) - every page
      // reached after that within this same run starts at 0.
      skipInCurrentPage = 0;
      pageCursor = discovery.nextPageCursor;
    } while (pageCursor !== null);
  } catch (error) {
    // discover() itself failed (after retries) — nothing recoverable
    // left to do this run.
    logger.error("discover() failed after retries — ending run early", error);
    await client.completeImportRun(runId, "failed", null, error instanceof Error ? error.message : String(error));
    return { runId, status: "failed", booksProcessed, booksFailed };
  }

  const status = sawAnyFailure && booksProcessed > 0 ? "partially_failed" : sawAnyFailure ? "failed" : "completed";
  // See the module-level comment above: resumeOnLimit holds the exact
  // { pageCursor, skip } to continue from if maxBooks cut this run
  // short; otherwise pageCursor is null (the `while` loop only exits
  // that way at the true end of the catalogue), which serializes to a
  // clean null - a fresh full restart next time. ADR-009: still only
  // advance the watermark on a run that isn't a total failure - a
  // failed run must not silently skip the window it never processed,
  // and is not retried automatically.
  const nextCursor = status !== "failed" ? serializeResumeCursor(limitReached ? resumeOnLimit : { pageCursor, skip: 0 }) : null;
  if (limitReached) {
    logger.log(`Persisting resume cursor ${JSON.stringify(nextCursor)} for the next run (maxBooks reached).`);
  }
  await client.completeImportRun(runId, status, nextCursor, null);

  return { runId, status, booksProcessed, booksFailed };
}

// See the module-level comment above for why this wrapper shape exists.
interface ResumeCursor {
  pageCursor: string | null;
  skip: number;
}

function parseResumeCursor(raw: string | null): ResumeCursor {
  if (!raw) {
    return { pageCursor: null, skip: 0 };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ResumeCursor>;
    if (typeof parsed.skip === "number" && (typeof parsed.pageCursor === "string" || parsed.pageCursor === null)) {
      return { pageCursor: parsed.pageCursor, skip: parsed.skip };
    }
  } catch {
    // Not JSON - falls through to the safe reset below.
  }
  // Unrecognized format, including a stale fabricated ISO timestamp
  // from before this fix - treated as "start fresh" rather than
  // trusted as a real page token (an adapter's discover() would choke
  // on it otherwise, e.g. Number(isoString) is NaN).
  return { pageCursor: null, skip: 0 };
}

function serializeResumeCursor(resume: ResumeCursor): string | null {
  // Nothing left to resume - a clean signal to start over from page 1.
  if (resume.pageCursor === null && resume.skip === 0) {
    return null;
  }
  return JSON.stringify(resume);
}
