import type { CanonicalBook, ValidationIssue, ValidationResult } from "./types";

// ISO 4217 — a real currency-code list is a much bigger table than is
// worth vendoring here; the platform only ever deals in these two per
// SPEC-01/SPEC-06, so this stays a short allow-list rather than a
// dependency.
const KNOWN_CURRENCIES = new Set(["INR", "USD"]);

// SPEC-04 §16's field-level rules only — the ones checkable without a
// database or a network call, so they can run identically on the
// GitHub Actions runner (as a cheap fail-fast before ever POSTing) and
// again inside apps/api-publisher-import (as part of the authoritative
// check, alongside the DB-backed rules that can't run here: duplicate
// ISBN detection, and "broken image" which needs an actual fetch —
// see that app's own validation service).
export function validateBookFields(book: CanonicalBook): ValidationResult {
  const issues: ValidationIssue[] = [];

  // title/language stay hard errors: promote-staging-book's own
  // create-new path throws without them (it needs both to create the
  // catalog.works row at all), so a staging book missing either can
  // never actually be promoted - auto-rejecting it here, before an
  // editor ever spends time on it, is the correct call.
  if (!book.title) {
    issues.push({ severity: "error", code: "missing_title", message: "Title is required." });
  }
  if (book.authorNames.length === 0) {
    issues.push({ severity: "error", code: "missing_author", message: "At least one author is required." });
  }
  // publisher/price/cover/currency downgraded from error to warning:
  // confirmed against promote-staging-book/src/api.ts that none of
  // these actually block promotion - promoteInventory() and
  // promoteMedia() both silently no-op when price/cover are absent,
  // and publisher_id/currency are inserted as-is with no validation
  // there. apps/web's BookCard already has purpose-built fallback UI
  // for both ("Unavailable" instead of a price, a title-text
  // placeholder instead of a cover image) - fallbacks that were
  // sitting unused because books missing these fields were being
  // silently auto-rejected before an editor ever saw them, rather than
  // landing in the normal pending_validation review queue a warning
  // produces. A warning still requires the same human approval before
  // promotion; this only changes whether that human gets a chance to
  // see the book at all.
  if (!book.publisherName) {
    issues.push({ severity: "warning", code: "missing_publisher", message: "Publisher is required." });
  }
  if (book.price === null) {
    issues.push({ severity: "warning", code: "missing_price", message: "Price is required." });
  }
  if (!book.language) {
    issues.push({ severity: "error", code: "missing_language", message: "Language is required." });
  }
  if (!book.coverSourceUrl) {
    issues.push({ severity: "warning", code: "missing_cover", message: "Cover image is required." });
  }

  if (book.currency && !KNOWN_CURRENCIES.has(book.currency)) {
    issues.push({
      severity: "warning",
      code: "invalid_currency",
      message: `Currency "${book.currency}" is not recognized.`,
    });
  }

  if (!book.isbn13) {
    issues.push({ severity: "warning", code: "missing_isbn", message: "ISBN is missing." });
  } else if (!/^\d{13}$/.test(book.isbn13)) {
    issues.push({ severity: "error", code: "invalid_isbn", message: "ISBN must be 13 digits." });
  }

  if (!book.description) {
    issues.push({ severity: "warning", code: "missing_description", message: "Description is missing." });
  }

  return {
    issues,
    hasErrors: issues.some((issue) => issue.severity === "error"),
  };
}
