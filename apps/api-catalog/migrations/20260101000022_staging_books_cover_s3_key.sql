-- Up Migration
-- Denormalized copy of the staging book's cover S3 key, write-through'd
-- from staging.staging_media.s3_key by
-- apps/api-publisher-import/staging-books.service.ts's submit() every
-- time a cover is stored. Directus's Table/Card layouts can't reach
-- into a *related* collection to render a thumbnail (see
-- apps/directus/scripts/bootstrap.ts's ensureImageThumbnailDisplays()
-- comment) — a field has to live on the row itself for the image-url
-- display to render it directly on the staging_books browse table,
-- which is the whole point of this column: staging_books.cover_source_url
-- and staging_media.source_url both hold the raw externally-crawled
-- URL (can't render under Directus's CSP - see
-- terraform/environments/prod/directus.tf), so this is the CDN-servable
-- copy instead, kept in sync with whichever staging_media row is the
-- most recent successful cover download for this book.
ALTER TABLE staging.staging_books
  ADD COLUMN cover_s3_key text;

-- Down Migration

ALTER TABLE staging.staging_books
  DROP COLUMN IF EXISTS cover_s3_key;
