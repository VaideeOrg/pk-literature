-- Up Migration
-- Third publisher record, alongside Kalachuvadu and Ethirveliyeedu (see
-- 20260101000009_seed_kalachuvadu_publisher.sql and
-- 20260101000026_seed_ethirveliyeedu_publisher.sql). Yaavarum is also a
-- Shopify storefront exposing a public products.json feed, but
-- adapter_type is 'html' here, not 'json_feed': author names only
-- exist on the rendered product detail page, not the feed, so
-- YaavarumAdapter's fetchBook() makes a real per-book HTML fetch (the
-- feed is only used for discovery/pagination/price/stock/cover) - the
-- per-book mechanism/cost is a real HTML crawl, same category as
-- Kalachuvadu. code must stay 'yaavarum' to match the adapter
-- registered in apps/publisher-crawler/src/adapters-registry.ts. Like
-- Ethirveliyeedu, this is a multi-publisher storefront - vendor varies
-- per product and is read from each book's own page, not from this row.
--
-- No id is set here (DB-generated, same as the other two seeds) - after
-- running this migration, fetch it for use as the workflow_dispatch
-- publisher_id input:
--   SELECT id FROM catalog.publishers WHERE code = 'yaavarum';

INSERT INTO catalog.publishers (name, code, website, adapter_type, active)
VALUES (
  'Yaavarum',
  'yaavarum',
  'https://yaavarum.com/collections/all/products.json',
  'html',
  true
)
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM catalog.publishers WHERE code = 'yaavarum';
