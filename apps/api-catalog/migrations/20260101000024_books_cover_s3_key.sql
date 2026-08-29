-- Up Migration
-- Denormalized copy of a book's cover S3 key, write-through'd from
-- catalog.media_assets.s3_key by promote-staging-book's promoteMedia()
-- the same time it sets books.cover_asset_id. Same reasoning as
-- staging.staging_books.cover_s3_key (migration 20260101000022):
-- Directus's Table/Card layouts can't reach into a *related*
-- collection to render a thumbnail - cover_asset_id is a real M2O
-- relation to catalog.media_assets, not a bare key on the row itself,
-- so a field has to live directly on catalog.books for the
-- image-url display to render it on the Browse table.
ALTER TABLE catalog.books
  ADD COLUMN cover_s3_key text;

-- Down Migration

ALTER TABLE catalog.books
  DROP COLUMN IF EXISTS cover_s3_key;
