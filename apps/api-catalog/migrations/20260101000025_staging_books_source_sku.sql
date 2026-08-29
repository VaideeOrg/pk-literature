-- Up Migration
-- Publisher's own internal SKU/product-id, kept separate from isbn13
-- rather than folded into it — a publisher's SKU is not guaranteed to
-- actually be an ISBN even when it looks numeric (e.g. Ethirveliyeedu's
-- Shopify variant.sku), so this stays its own column. isbn13 is only
-- ever populated from an adapter's explicit ISBN extraction, never
-- derived from this. null for adapters with no such concept (e.g.
-- Kalachuvadu).
ALTER TABLE staging.staging_books
  ADD COLUMN source_sku text;

-- Down Migration

ALTER TABLE staging.staging_books
  DROP COLUMN IF EXISTS source_sku;
