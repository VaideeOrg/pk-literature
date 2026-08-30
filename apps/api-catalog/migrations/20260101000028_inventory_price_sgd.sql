-- Up Migration
-- Market-scoped price override for the puthagakadai.sg storefront —
-- a plain nullable column, not a separate price-list table: exactly
-- two markets exist today (India/INR via the existing price/currency
-- columns, Singapore/SGD here), and a market-price table would add
-- JOIN + row-existence-fallback complexity for no benefit at this
-- scale. No separate currency column either - the market->currency
-- mapping is fixed (SG is always SGD) and belongs in the API layer,
-- not a redundant data column.
--
-- NULL means "not yet priced for SG" - api-catalog's toInventory()
-- treats that exactly like the existing "no price = unavailable"
-- convention already used everywhere (BookCard, ReelBookSlide,
-- checkout validation), so a book without an SG price simply shows as
-- unavailable on that storefront rather than needing a new UI state.
ALTER TABLE catalog.inventory
  ADD COLUMN price_sgd numeric(10,2);

-- Down Migration

ALTER TABLE catalog.inventory
  DROP COLUMN IF EXISTS price_sgd;
