-- Up Migration
-- medusa_app needs to read catalog.books/catalog.inventory for the
-- store-order creation UI's book picker (search by title, prefill unit
-- price from current inventory) - apps/medusa/src/lib/
-- commerce-orders.repository.ts's searchCatalogBooks(). Mirrors
-- commerce_api_role.sql's identical catalog grant exactly, including
-- the same constraint: read-only. medusa_app's own writes stay
-- confined to `commerce` (migration 20260401000004_medusa_app_role.sql)
-- and `medusa` - it never writes to catalog.inventory directly, same
-- "Directus is the sole write path into catalog" boundary as every
-- other service (see decrement-inventory-stock's own operation for how
-- an actual stock write happens).

GRANT USAGE ON SCHEMA catalog TO medusa_app;
GRANT SELECT ON ALL TABLES IN SCHEMA catalog TO medusa_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA catalog GRANT SELECT ON TABLES TO medusa_app;

-- Down Migration

ALTER DEFAULT PRIVILEGES IN SCHEMA catalog REVOKE SELECT ON TABLES FROM medusa_app;
REVOKE SELECT ON ALL TABLES IN SCHEMA catalog FROM medusa_app;
REVOKE USAGE ON SCHEMA catalog FROM medusa_app;
