-- Up Migration
-- Renames the staging.staging_book_status enum's terminal value from
-- 'merged' to 'promoted' - a clearer name for what actually happens
-- (promote-staging-book writing the staging row into
-- catalog.works/catalog.books), decided while building the Directus
-- Approve button/UI. RENAME VALUE is a metadata-only catalog change
-- (PG10+) - existing rows keep the exact same underlying enum OID,
-- only the displayed label changes, so no backfill/UPDATE is needed
-- and this is safe to run with existing 'merged' rows already in the
-- table.
ALTER TYPE staging.staging_book_status RENAME VALUE 'merged' TO 'promoted';

-- Down Migration

ALTER TYPE staging.staging_book_status RENAME VALUE 'promoted' TO 'merged';
