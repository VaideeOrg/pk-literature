-- Up Migration
-- Second publisher record, alongside Kalachuvadu (see
-- 20260101000009_seed_kalachuvadu_publisher.sql). Ethirveliyeedu is a
-- Shopify storefront exposing a public products.json feed — adapter_type
-- is 'json_feed' (SPEC-04 §7's "Recommended" type), not 'html', and not
-- a Shopify-specific enum value: this column categorizes by mechanism
-- (HTML/REST/GraphQL/CSV/JSON feed), not by platform. code must stay
-- 'ethirveliyeedu' to match the adapter registered in
-- apps/publisher-crawler/src/adapters-registry.ts. Unlike Kalachuvadu,
-- this site is a multi-publisher bookstore — vendor varies per product
-- and is read from each book's own page, not from this row.
--
-- No id is set here (DB-generated, same as the Kalachuvadu row) — after
-- running this migration, fetch it for use as the workflow_dispatch
-- publisher_id input:
--   SELECT id FROM catalog.publishers WHERE code = 'ethirveliyeedu';

INSERT INTO catalog.publishers (name, code, website, adapter_type, active)
VALUES (
  'Ethir Veliyeedu',
  'ethirveliyeedu',
  'https://ethirveliyeedu.com/collections/all/products.json',
  'json_feed',
  true
)
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM catalog.publishers WHERE code = 'ethirveliyeedu';
