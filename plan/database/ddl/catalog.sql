-- catalog schema
-- Source of truth for Tamil literature bibliographic + editorial data.
-- Written to directly by Directus (the editorial workbench) and by the
-- catalog-service migration runner. Never written to by the Catalog
-- Lambda API, which is read-only, and never written to directly by
-- publisher adapters, which write only to the `staging` schema.
--
-- Model: an abstract `works` (the literary work, language-independent)
-- has one or more `books` (a specific published edition/translation/
-- printing, ISBN-bearing, purchasable). This replaces the flat
-- "edition is just a field on Book" model in early SPEC-02 drafts —
-- see plan/specs/spec-02-catalog-domain.md and plan/specs/spec-15
-- for the rationale.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy search (SPEC-08)

CREATE SCHEMA IF NOT EXISTS catalog;

-- Shared trigger to maintain updated_at across every table in this schema.
CREATE OR REPLACE FUNCTION catalog.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Shared editorial lifecycle. Used by works, books, and collections.
CREATE TYPE catalog.editorial_status AS ENUM (
  'draft',
  'needs_review',
  'approved',
  'published',
  'archived'
);

-- ---------------------------------------------------------------------
-- Publishers
-- ---------------------------------------------------------------------

CREATE TYPE catalog.publisher_adapter_type AS ENUM (
  'manual', 'html', 'rest', 'graphql', 'csv', 'json_feed'
);

CREATE TABLE catalog.publishers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  code             text NOT NULL,                 -- short slug, used by adapters/config
  website          text,
  country          char(2),                        -- ISO 3166-1 alpha-2
  logo_asset_id    uuid,                            -- FK added after media_assets defined
  adapter_type     catalog.publisher_adapter_type NOT NULL DEFAULT 'manual',
  active           boolean NOT NULL DEFAULT true,
  -- Incremental import cursor (SPEC-04 §21). Opaque, adapter-defined
  -- format (last page token / timestamp / source id — whatever that
  -- publisher's pagination needs). Read by the external adapter runner
  -- via the staging-ingest API before a run, written back on successful
  -- completion — see ADR-009 and staging.sql import_runs.
  last_import_cursor text,
  last_import_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT publishers_code_unique UNIQUE (code)
);
CREATE TRIGGER trg_publishers_updated_at
  BEFORE UPDATE ON catalog.publishers
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

-- ---------------------------------------------------------------------
-- Media assets (covers, publisher logos, promo banners) — S3-backed.
-- ---------------------------------------------------------------------

CREATE TYPE catalog.media_asset_type AS ENUM ('cover', 'publisher_logo', 'banner', 'author_photo');

CREATE TABLE catalog.media_assets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_type       catalog.media_asset_type NOT NULL,
  s3_key           text NOT NULL,
  content_type     text NOT NULL,
  width_px         integer,
  height_px        integer,
  checksum_sha256  text,
  source_url       text,                            -- original URL, if downloaded by an adapter
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_assets_s3_key_unique UNIQUE (s3_key)
);

ALTER TABLE catalog.publishers
  ADD CONSTRAINT publishers_logo_asset_fk
  FOREIGN KEY (logo_asset_id) REFERENCES catalog.media_assets(id);

-- ---------------------------------------------------------------------
-- Authors (also used for translators/illustrators via book_contributors)
-- ---------------------------------------------------------------------

CREATE TABLE catalog.authors (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name   text NOT NULL,                   -- normalized display name, e.g. "Jeyamohan"
  native_name      text,                             -- original script, e.g. "ஜெயமோகன்"
  biography        text,
  birth_year       integer,
  death_year       integer,
  photo_asset_id   uuid REFERENCES catalog.media_assets(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_authors_updated_at
  BEFORE UPDATE ON catalog.authors
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

-- Alternate names/spellings an author is known by (import normalization,
-- per SPEC-04 section 14 — "Alias stored").
CREATE TABLE catalog.author_aliases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id        uuid NOT NULL REFERENCES catalog.authors(id) ON DELETE CASCADE,
  alias            text NOT NULL,
  script           text,                             -- e.g. 'ta', 'ta-Latn', 'en'
  CONSTRAINT author_aliases_unique UNIQUE (author_id, alias)
);

-- ---------------------------------------------------------------------
-- Themes, genres, literary movements — editor-curated lookup tables.
-- ---------------------------------------------------------------------

CREATE TABLE catalog.themes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  CONSTRAINT themes_slug_unique UNIQUE (slug)
);

CREATE TABLE catalog.genres (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  CONSTRAINT genres_slug_unique UNIQUE (slug)
);

CREATE TABLE catalog.literary_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  period_start_year integer,
  period_end_year   integer,
  CONSTRAINT literary_movements_slug_unique UNIQUE (slug)
);

-- ---------------------------------------------------------------------
-- Works — the abstract literary work, independent of language/edition.
-- Editorial metadata (summary, themes, genres, movements) attaches here
-- so a translation automatically inherits the same thematic metadata as
-- the original, rather than needing re-tagging per edition.
-- ---------------------------------------------------------------------

CREATE TYPE catalog.work_type AS ENUM (
  'novel', 'short_story_collection', 'poetry_collection',
  'essay_collection', 'drama', 'biography', 'non_fiction', 'other'
);

CREATE TABLE catalog.works (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title         text NOT NULL,             -- title in original_language
  canonical_title_translit text,                      -- romanized, for search/display
  original_language       char(2) NOT NULL,           -- ISO 639-1, e.g. 'ta'
  work_type               catalog.work_type NOT NULL DEFAULT 'other',
  first_publication_year  integer,
  summary                 text,
  status                  catalog.editorial_status NOT NULL DEFAULT 'draft',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_works_updated_at
  BEFORE UPDATE ON catalog.works
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

CREATE TABLE catalog.work_authors (
  work_id     uuid NOT NULL REFERENCES catalog.works(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES catalog.authors(id) ON DELETE RESTRICT,
  role        text NOT NULL DEFAULT 'author',          -- 'author' | 'co_author' | 'compiler'
  sort_order  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (work_id, author_id, role)
);

CREATE TABLE catalog.work_themes (
  work_id   uuid NOT NULL REFERENCES catalog.works(id) ON DELETE CASCADE,
  theme_id  uuid NOT NULL REFERENCES catalog.themes(id) ON DELETE RESTRICT,
  PRIMARY KEY (work_id, theme_id)
);

CREATE TABLE catalog.work_genres (
  work_id   uuid NOT NULL REFERENCES catalog.works(id) ON DELETE CASCADE,
  genre_id  uuid NOT NULL REFERENCES catalog.genres(id) ON DELETE RESTRICT,
  PRIMARY KEY (work_id, genre_id)
);

CREATE TABLE catalog.work_literary_movements (
  work_id             uuid NOT NULL REFERENCES catalog.works(id) ON DELETE CASCADE,
  literary_movement_id uuid NOT NULL REFERENCES catalog.literary_movements(id) ON DELETE RESTRICT,
  PRIMARY KEY (work_id, literary_movement_id)
);

-- ---------------------------------------------------------------------
-- Books — a specific purchasable edition/translation/printing of a Work.
-- This is what the storefront, cart, and orders reference by id.
-- ---------------------------------------------------------------------

CREATE TYPE catalog.book_format AS ENUM ('paperback', 'hardcover');

CREATE TABLE catalog.books (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id                uuid NOT NULL REFERENCES catalog.works(id) ON DELETE RESTRICT,
  publisher_id           uuid NOT NULL REFERENCES catalog.publishers(id) ON DELETE RESTRICT,
  translated_from_book_id uuid REFERENCES catalog.books(id),  -- nullable; set only for translations
  isbn13                 char(13),                             -- nullable: many Tamil small-press
                                                                -- books never had an ISBN assigned
  title                  text NOT NULL,                        -- edition-specific title (may differ
                                                                 -- from work.canonical_title in translations)
  subtitle               text,
  language               char(2) NOT NULL,                     -- ISO 639-1 of THIS edition
  edition_label          text,                                 -- e.g. "2nd Edition", "Revised"
  edition_number         smallint,
  format                 catalog.book_format NOT NULL DEFAULT 'paperback',
  page_count             integer,
  publication_date       date,
  cover_asset_id         uuid REFERENCES catalog.media_assets(id),
  status                 catalog.editorial_status NOT NULL DEFAULT 'draft',
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_isbn13_unique UNIQUE (isbn13),
  CONSTRAINT books_isbn13_format CHECK (isbn13 IS NULL OR isbn13 ~ '^[0-9]{13}$'),
  CONSTRAINT books_page_count_positive CHECK (page_count IS NULL OR page_count > 0)
);
CREATE TRIGGER trg_books_updated_at
  BEFORE UPDATE ON catalog.books
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

-- Status invariant: a Book cannot become Published unless its Work has
-- already been editorially approved. A Work is promoted to Published
-- automatically the first time any of its Books publishes; it never
-- auto-reverts to Archived when its Books are archived — that stays an
-- explicit editor action so a Work doesn't silently disappear.
CREATE OR REPLACE FUNCTION catalog.enforce_book_work_status()
RETURNS trigger AS $$
DECLARE
  work_status catalog.editorial_status;
BEGIN
  IF NEW.status = 'published' THEN
    SELECT status INTO work_status FROM catalog.works WHERE id = NEW.work_id;
    IF work_status NOT IN ('approved', 'published') THEN
      RAISE EXCEPTION 'Book % cannot be published: work % is not approved (status=%)',
        NEW.id, NEW.work_id, work_status;
    END IF;
    UPDATE catalog.works SET status = 'published'
      WHERE id = NEW.work_id AND status <> 'published';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_books_enforce_work_status
  BEFORE INSERT OR UPDATE OF status ON catalog.books
  FOR EACH ROW EXECUTE FUNCTION catalog.enforce_book_work_status();

-- Edition-specific contributors: translator, illustrator, editor of THIS
-- printing (distinct from work_authors, which is the original author(s)).
CREATE TABLE catalog.book_contributors (
  book_id     uuid NOT NULL REFERENCES catalog.books(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES catalog.authors(id) ON DELETE RESTRICT,
  role        text NOT NULL,                          -- 'translator' | 'illustrator' | 'editor' | 'foreword'
  sort_order  smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, author_id, role)
);

-- ---------------------------------------------------------------------
-- Collections — editorial shelves (Editor's Picks, New Arrivals, ...).
-- Attached to Books (specific purchasable editions), not Works, since a
-- collection like "New Arrivals" is inherently about a specific printing
-- becoming available, not the abstract work.
-- ---------------------------------------------------------------------

CREATE TABLE catalog.collections (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL,
  description text,
  status      catalog.editorial_status NOT NULL DEFAULT 'draft',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collections_slug_unique UNIQUE (slug)
);
CREATE TRIGGER trg_collections_updated_at
  BEFORE UPDATE ON catalog.collections
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

CREATE TABLE catalog.book_collections (
  book_id       uuid NOT NULL REFERENCES catalog.books(id) ON DELETE CASCADE,
  collection_id uuid NOT NULL REFERENCES catalog.collections(id) ON DELETE CASCADE,
  sort_order    smallint NOT NULL DEFAULT 0,
  PRIMARY KEY (book_id, collection_id)
);

-- ---------------------------------------------------------------------
-- Inventory — 1:1 with books. Deliberately a separate table so the
-- publisher-adapter inventory-sync path structurally cannot touch
-- editorial columns on `books` (SPEC-02 business rule: "Inventory
-- updates never overwrite editorial metadata").
-- ---------------------------------------------------------------------

CREATE TYPE catalog.inventory_availability AS ENUM (
  'in_stock', 'out_of_stock', 'preorder', 'discontinued'
);
CREATE TYPE catalog.inventory_updated_by AS ENUM ('adapter', 'editor');

CREATE TABLE catalog.inventory (
  book_id         uuid PRIMARY KEY REFERENCES catalog.books(id) ON DELETE CASCADE,
  sku             text,
  stock           integer NOT NULL DEFAULT 0,
  price           numeric(10,2) NOT NULL,
  currency        char(3) NOT NULL DEFAULT 'INR',
  price_sgd       numeric(10,2),        -- puthagakadai.sg storefront override, always SGD;
                                          -- NULL = not yet priced for SG (shows as unavailable there)
  availability    catalog.inventory_availability NOT NULL DEFAULT 'in_stock',
  last_sync_time  timestamptz,
  updated_by      catalog.inventory_updated_by NOT NULL DEFAULT 'editor',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_stock_nonnegative CHECK (stock >= 0),
  CONSTRAINT inventory_price_nonnegative CHECK (price >= 0)
);
CREATE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON catalog.inventory
  FOR EACH ROW EXECUTE FUNCTION catalog.set_updated_at();

-- ---------------------------------------------------------------------
-- Full text search support (SPEC-08). Populated via trigger, not
-- computed at query time, so search stays fast as the catalog grows.
-- ---------------------------------------------------------------------

ALTER TABLE catalog.books ADD COLUMN search_vector tsvector;

CREATE OR REPLACE FUNCTION catalog.books_search_vector_update()
RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.subtitle, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.isbn13, '')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_books_search_vector
  BEFORE INSERT OR UPDATE OF title, subtitle, isbn13 ON catalog.books
  FOR EACH ROW EXECUTE FUNCTION catalog.books_search_vector_update();

-- Indexes — see plan/database/indexes/index-strategy.md for rationale.
CREATE INDEX idx_books_search_vector ON catalog.books USING GIN (search_vector);
CREATE INDEX idx_books_title_trgm ON catalog.books USING GIN (title gin_trgm_ops);
CREATE INDEX idx_authors_canonical_name_trgm ON catalog.authors USING GIN (canonical_name gin_trgm_ops);
CREATE INDEX idx_books_work_id ON catalog.books (work_id);
CREATE INDEX idx_books_publisher_id ON catalog.books (publisher_id);
CREATE INDEX idx_books_status ON catalog.books (status) WHERE status = 'published';
CREATE INDEX idx_works_status ON catalog.works (status) WHERE status = 'published';
