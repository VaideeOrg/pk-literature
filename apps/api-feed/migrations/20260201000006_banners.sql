-- Up Migration
-- Homepage promotional banner (customer-facing UI gap, scoped down to
-- "a single banner image linking to one book" — no scheduling/carousel).
-- Lives in `discovery` (api-feed's schema, not `catalog`) since it's
-- homepage placement, not catalog data — mirrors discovery.feed_shelves'
-- pattern of referencing catalog rows by id rather than duplicating
-- their data. Directus authors it (see bootstrap.ts's DISCOVERY_COLLECTIONS),
-- apps/api-feed serves it as part of GET /v1/feed.

CREATE TABLE discovery.banners (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_asset_id uuid NOT NULL REFERENCES catalog.media_assets(id),
  book_id        uuid NOT NULL REFERENCES catalog.books(id) ON DELETE CASCADE,
  headline       text,
  sort_order     smallint NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_banners_updated_at
  BEFORE UPDATE ON discovery.banners
  FOR EACH ROW EXECUTE FUNCTION discovery.set_updated_at();

CREATE INDEX idx_banners_enabled_sort ON discovery.banners (sort_order) WHERE enabled = true;

-- feed_api_rw already has SELECT/INSERT/UPDATE on every discovery table
-- via the schema-level default privileges set up in
-- 20260201000002_feed_api_role.sql (ALTER DEFAULT PRIVILEGES IN SCHEMA
-- discovery ... TO feed_api_rw), which applies automatically to tables
-- created afterward by the same migration-running role — no explicit
-- grant needed here, same as feed_shelves/interest_events before it.

-- directus_app is NOT covered by that default-privileges rule (it's
-- scoped to feed_api_rw only) and has no standing grant on `discovery`
-- at all (20260101000006_directus_app_role.sql only covers catalog +
-- staging — discovery was deliberately left out, see directus.tf's
-- DB_SEARCH_PATH comment: an earlier attempt to add the whole schema to
-- Directus's search path 42501'd with "permission denied for schema
-- discovery"). Grant it access to exactly this one table, not the
-- schema-wide interest_profiles/interest_events/feed_shelves data it
-- has no editorial reason to touch.
GRANT USAGE ON SCHEMA discovery TO directus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON discovery.banners TO directus_app;

-- Down Migration

REVOKE SELECT, INSERT, UPDATE, DELETE ON discovery.banners FROM directus_app;
REVOKE USAGE ON SCHEMA discovery FROM directus_app;
DROP INDEX IF EXISTS idx_banners_enabled_sort;
DROP TRIGGER IF EXISTS trg_banners_updated_at ON discovery.banners;
DROP TABLE IF EXISTS discovery.banners;
