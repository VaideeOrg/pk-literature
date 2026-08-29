-- staging schema
-- Landing zone for publisher-adapter imports (SPEC-04). Nothing here is
-- ever visible to public APIs. Rows move from staging -> catalog only
-- through editorial approval in Directus (SPEC-03), never automatically.
--
-- Depends on catalog schema for FK targets (publishers, and the
-- production book/work a staging row gets matched/merged against).

CREATE SCHEMA IF NOT EXISTS staging;

CREATE OR REPLACE FUNCTION staging.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Import runs — one row per adapter execution (scheduled or manual).
-- ---------------------------------------------------------------------

CREATE TYPE staging.import_run_status AS ENUM (
  'running', 'completed', 'failed', 'partially_failed'
);

CREATE TABLE staging.import_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_id    uuid NOT NULL REFERENCES catalog.publishers(id),
  trigger         text NOT NULL DEFAULT 'scheduled',   -- 'scheduled' | 'manual' | 'retry'
  status          staging.import_run_status NOT NULL DEFAULT 'running',
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  total_books     integer NOT NULL DEFAULT 0,
  new_books       integer NOT NULL DEFAULT 0,
  updated_books   integer NOT NULL DEFAULT 0,
  rejected_books  integer NOT NULL DEFAULT 0,
  error_summary   text
);
CREATE INDEX idx_import_runs_publisher_id ON staging.import_runs (publisher_id);

-- ---------------------------------------------------------------------
-- Staging books — one row per book extracted from a publisher source,
-- before normalization/validation/editorial review.
-- ---------------------------------------------------------------------

CREATE TYPE staging.staging_book_status AS ENUM (
  'pending_validation', 'needs_review', 'approved', 'rejected', 'promoted'
);

CREATE TABLE staging.staging_books (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id      uuid NOT NULL REFERENCES staging.import_runs(id) ON DELETE CASCADE,
  publisher_id       uuid NOT NULL REFERENCES catalog.publishers(id),
  source_ref         text NOT NULL,           -- publisher's own id/URL for this book — used for
                                                -- incremental import diffing (SPEC-04 section 21)
  raw_payload        jsonb NOT NULL,           -- untouched adapter output, kept for audit/replay
  source_sku         text,                     -- publisher's own internal SKU, kept separate from
                                                -- isbn13 (never cross-populated - see migration
                                                -- 20260101000025); null for adapters with no such concept

  -- Extracted + normalized fields (SPEC-04 section 12 minimum fields)
  isbn13             char(13),
  title              text,
  subtitle           text,
  author_names       text[],                   -- raw names as extracted; matched to catalog.authors
                                                 -- (or created new) only at approval time
  publisher_name     text,
  description        text,
  language            char(2),
  cover_source_url    text,
  price               numeric(10,2),
  currency            char(3),
  stock               integer,
  category            text,
  publication_date    date,
  edition_label        text,
  page_count           integer,

  -- Duplicate-detection outcome (SPEC-04 section 15 / SPEC-03 duplicate detection)
  matched_work_id     uuid REFERENCES catalog.works(id),
  matched_book_id      uuid REFERENCES catalog.books(id),
  match_confidence     numeric(4,3),            -- 0.000-1.000, null if no candidate match found

  status               staging.staging_book_status NOT NULL DEFAULT 'pending_validation',
  reviewed_by           text,                    -- Directus editorial user id/email
  reviewed_at            timestamptz,
  review_decision_notes   text,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT staging_books_source_unique UNIQUE (publisher_id, source_ref)
);
CREATE TRIGGER trg_staging_books_updated_at
  BEFORE UPDATE ON staging.staging_books
  FOR EACH ROW EXECUTE FUNCTION staging.set_updated_at();
CREATE INDEX idx_staging_books_import_run_id ON staging.staging_books (import_run_id);
CREATE INDEX idx_staging_books_status ON staging.staging_books (status);
CREATE INDEX idx_staging_books_isbn13 ON staging.staging_books (isbn13);

-- ---------------------------------------------------------------------
-- Staging inventory — kept separate from staging_books so an inventory-
-- only incremental sync (price/stock change, no metadata change) doesn't
-- need to touch or re-review the book record at all.
-- ---------------------------------------------------------------------

CREATE TABLE staging.staging_inventory (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_book_id  uuid NOT NULL REFERENCES staging.staging_books(id) ON DELETE CASCADE,
  sku              text,
  stock            integer,
  price            numeric(10,2),
  currency         char(3),
  availability     text,
  captured_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staging_inventory_staging_book_id ON staging.staging_inventory (staging_book_id);

-- ---------------------------------------------------------------------
-- Staging media — cover download/processing pipeline (SPEC-04 section 13).
-- ---------------------------------------------------------------------

CREATE TYPE staging.media_status AS ENUM (
  'pending', 'downloaded', 'virus_scanned', 'optimized', 'uploaded', 'failed'
);

CREATE TABLE staging.staging_media (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_book_id  uuid NOT NULL REFERENCES staging.staging_books(id) ON DELETE CASCADE,
  source_url       text NOT NULL,
  status           staging.media_status NOT NULL DEFAULT 'pending',
  s3_key           text,                        -- set once uploaded; becomes catalog.media_assets.s3_key
                                                  -- on approval
  checksum_sha256  text,
  failure_reason   text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staging_media_staging_book_id ON staging.staging_media (staging_book_id);

-- ---------------------------------------------------------------------
-- Staging validation — duplicate/validation issues surfaced to editors
-- (SPEC-04 section 16, SPEC-03 "Validation Results").
-- ---------------------------------------------------------------------

CREATE TYPE staging.validation_severity AS ENUM ('warning', 'error');

CREATE TABLE staging.staging_validation (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_book_id  uuid NOT NULL REFERENCES staging.staging_books(id) ON DELETE CASCADE,
  severity         staging.validation_severity NOT NULL,
  code             text NOT NULL,                -- e.g. 'missing_isbn', 'duplicate_isbn', 'broken_image'
  message          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staging_validation_staging_book_id ON staging.staging_validation (staging_book_id);

-- ---------------------------------------------------------------------
-- Staging relationships — proposed theme/genre/author links an adapter
-- or AI enrichment suggests, pending editor approval (SPEC-03 AI
-- Assisted Enrichment: "Suggestions require editor approval").
-- ---------------------------------------------------------------------

CREATE TABLE staging.staging_relationships (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staging_book_id   uuid NOT NULL REFERENCES staging.staging_books(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,               -- e.g. 'theme', 'genre', 'literary_movement'
  target_label      text NOT NULL,               -- proposed value, e.g. "Spirituality"
  target_id         uuid,                        -- resolved catalog id, once matched to an existing row
  suggested_by      text NOT NULL DEFAULT 'adapter',  -- 'adapter' | 'ai_enrichment'
  confidence        numeric(4,3),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_staging_relationships_staging_book_id ON staging.staging_relationships (staging_book_id);
