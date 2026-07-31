-- Up Migration
-- Tags every order with where the sale actually happened: the online
-- storefront, or one of the two physical stores. Existing orders (all
-- online so far - apps/medusa's manual-store-order UI didn't exist
-- before this migration) get the default transparently.
--
-- A plain enum, not a separate `sales_channels` table - there are
-- exactly three, they're not editor-managed content the way
-- catalog.collections/themes are, and a new physical store is rare
-- enough that a migration to extend this enum is the right amount of
-- ceremony for it.

CREATE TYPE commerce.order_channel AS ENUM ('online', 'store_erode', 'store_perundurai');

ALTER TABLE commerce.orders
  ADD COLUMN channel commerce.order_channel NOT NULL DEFAULT 'online';

-- Down Migration

ALTER TABLE commerce.orders DROP COLUMN channel;
DROP TYPE IF EXISTS commerce.order_channel;
