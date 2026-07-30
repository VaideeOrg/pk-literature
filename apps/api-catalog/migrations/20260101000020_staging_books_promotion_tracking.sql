-- Up Migration
-- Scaffolding for the staging -> catalog promotion pipeline (Directus
-- Flow + custom operation, apps/directus/extensions/operations/
-- promote-staging-book). staging_books already had matched_work_id/
-- matched_book_id (editor/duplicate-detection input: "this staging row
-- might be the same as this existing catalog row"); these two are the
-- symmetric *output* pointers - "this staging row's promotion actually
-- resulted in this catalog row" - set once promotion succeeds and
-- status flips to 'merged'.
--
-- Doubles as the idempotency guard: the promotion operation checks
-- promoted_book_id IS NULL before doing any catalog writes, so a
-- staging row can't be promoted twice even if its status is somehow
-- re-set to 'approved' after already being 'merged'.
ALTER TABLE staging.staging_books
  ADD COLUMN promoted_work_id uuid REFERENCES catalog.works(id),
  ADD COLUMN promoted_book_id uuid REFERENCES catalog.books(id);

CREATE INDEX idx_staging_books_promoted_book_id ON staging.staging_books (promoted_book_id);

-- Down Migration

DROP INDEX IF EXISTS staging.idx_staging_books_promoted_book_id;
ALTER TABLE staging.staging_books
  DROP COLUMN IF EXISTS promoted_book_id,
  DROP COLUMN IF EXISTS promoted_work_id;
