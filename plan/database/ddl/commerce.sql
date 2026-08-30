-- commerce schema
-- Cart, checkout, orders, payments, shipments, refunds (SPEC-06).
-- Owned/written by apps/api-commerce as commerce_api_rw. Depends on
-- catalog schema for book references — read-only from this schema's
-- perspective (infrastructure/iam.md: commerce_api_rw is read-only on
-- catalog, same "own inventory stays in Catalog" split ADR-009 already
-- established for staging_books vs catalog).
--
-- Deliberately does NOT own product/pricing/inventory data: SPEC-06's
-- "Does Not Own: Books, Authors, Publishers, Themes, Editorial
-- metadata" and "Inventory ownership remains in Catalog. Commerce
-- stores only a purchase snapshot" — every book_id column here is a
-- read-only reference into catalog.books, and title/unit_price are
-- snapshotted at add-to-cart/order time so a later catalog price change
-- never silently rewrites a customer's cart or an already-placed order.
--
-- Medusa (SPEC-06 "Medusa Responsibilities": order management, customer
-- management, shipment status, refunds, admin UI — "No catalog
-- ownership") is the admin surface over this same schema, analogous to
-- how Directus is the admin surface over `catalog` (SPEC-03) — see
-- apps/medusa/README.md for why a live instance could not be verified
-- in this environment (same category of limitation as apps/directus's
-- own README, not solved here either).

CREATE SCHEMA IF NOT EXISTS commerce;

CREATE OR REPLACE FUNCTION commerce.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Customers + addresses. SPEC-06 "Anonymous checkout supported" — both
-- customer_id columns elsewhere in this schema are nullable; a
-- customer row here is just contact details captured at checkout, not
-- an authenticated account (SPEC-07/Identity, Phase 7, owns real user
-- accounts and will link to this table then — "Registration merges
-- existing anonymous data" per spec-07's own acceptance criteria).
-- ---------------------------------------------------------------------

CREATE TABLE commerce.customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text,
  phone      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_customers_updated_at
  BEFORE UPDATE ON commerce.customers
  FOR EACH ROW EXECUTE FUNCTION commerce.set_updated_at();

CREATE TABLE commerce.addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid REFERENCES commerce.customers(id) ON DELETE CASCADE,
  recipient_name text NOT NULL,
  line1          text NOT NULL,
  line2          text,
  city           text NOT NULL,
  state          text NOT NULL,
  postal_code    text NOT NULL,
  country        char(2) NOT NULL DEFAULT 'IN',
  phone          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_addresses_customer_id ON commerce.addresses (customer_id);

-- ---------------------------------------------------------------------
-- Cart. SPEC-06 "Cart Items: book_id, title snapshot, unit_price,
-- quantity" — exactly those four plus bookkeeping columns, nothing
-- from catalog beyond the id reference.
-- ---------------------------------------------------------------------

CREATE TYPE commerce.cart_status AS ENUM ('active', 'merged', 'converted', 'abandoned');

CREATE TABLE commerce.cart (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one of these is set: an anonymous cart until login, a
  -- customer cart after ("Cart merge on login" moves items from the
  -- anonymous cart into the customer's, then marks the anonymous one
  -- 'merged' rather than deleting it, preserving the audit trail).
  anonymous_id  uuid,
  customer_id   uuid REFERENCES commerce.customers(id) ON DELETE CASCADE,
  status        commerce.cart_status NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_owner_check CHECK (
    (anonymous_id IS NOT NULL AND customer_id IS NULL) OR
    (anonymous_id IS NULL AND customer_id IS NOT NULL)
  )
);
CREATE TRIGGER trg_cart_updated_at
  BEFORE UPDATE ON commerce.cart
  FOR EACH ROW EXECUTE FUNCTION commerce.set_updated_at();
-- Partial unique indexes (not a table-wide UNIQUE) since most carts
-- have a null customer_id or null anonymous_id — a plain UNIQUE
-- constraint treats every NULL as distinct anyway in Postgres, but an
-- explicit partial index states the actual intent (one active
-- anonymous cart per anonymous_id, one active cart per customer_id)
-- rather than relying on that NULL-handling quirk implicitly.
CREATE UNIQUE INDEX idx_cart_one_active_per_anonymous ON commerce.cart (anonymous_id) WHERE status = 'active' AND anonymous_id IS NOT NULL;
CREATE UNIQUE INDEX idx_cart_one_active_per_customer ON commerce.cart (customer_id) WHERE status = 'active' AND customer_id IS NOT NULL;

CREATE TABLE commerce.cart_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id        uuid NOT NULL REFERENCES commerce.cart(id) ON DELETE CASCADE,
  book_id        uuid NOT NULL REFERENCES catalog.books(id),
  title_snapshot text NOT NULL,
  unit_price     numeric(10,2) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'INR',
  quantity       integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT cart_items_unit_price_nonnegative CHECK (unit_price >= 0),
  CONSTRAINT cart_items_cart_book_unique UNIQUE (cart_id, book_id)
);
CREATE TRIGGER trg_cart_items_updated_at
  BEFORE UPDATE ON commerce.cart_items
  FOR EACH ROW EXECUTE FUNCTION commerce.set_updated_at();
CREATE INDEX idx_cart_items_cart_id ON commerce.cart_items (cart_id);

-- ---------------------------------------------------------------------
-- Orders — SPEC-06 "Order Lifecycle": Draft -> Pending Payment -> Paid
-- -> Packed -> Shipped -> Delivered -> Completed, with Cancelled/
-- Refunded/Returned as alternative terminal states reachable from
-- several points in the happy path (enforced in application code,
-- state-machines/ convention elsewhere in this repo — not a DB
-- trigger, since the valid predecessor set differs per target state in
-- a way a single trigger function would just re-encode the same
-- state-machine table twice).
-- ---------------------------------------------------------------------

CREATE TYPE commerce.order_status AS ENUM (
  'draft', 'pending_payment', 'paid', 'packed', 'shipped', 'delivered',
  'completed', 'cancelled', 'refunded', 'returned'
);

CREATE TABLE commerce.orders (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number        text NOT NULL,
  customer_id         uuid REFERENCES commerce.customers(id),
  cart_id             uuid REFERENCES commerce.cart(id),
  status              commerce.order_status NOT NULL DEFAULT 'draft',
  subtotal            numeric(10,2) NOT NULL,
  shipping_cost       numeric(10,2) NOT NULL DEFAULT 0,
  total               numeric(10,2) NOT NULL,
  currency            char(3) NOT NULL DEFAULT 'INR',
  shipping_address_id uuid REFERENCES commerce.addresses(id),
  billing_address_id  uuid REFERENCES commerce.addresses(id),
  -- Anonymous checkout (SPEC-06 Principles) still needs a way to look
  -- an order back up without an account — a contact email/phone plus
  -- this order_number is that path (GET /orders/{id}, not listed by
  -- customer_id when there isn't one).
  contact_email       text,
  contact_phone       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_order_number_unique UNIQUE (order_number),
  CONSTRAINT orders_subtotal_nonnegative CHECK (subtotal >= 0),
  CONSTRAINT orders_total_nonnegative CHECK (total >= 0)
);
CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON commerce.orders
  FOR EACH ROW EXECUTE FUNCTION commerce.set_updated_at();
CREATE INDEX idx_orders_customer_id ON commerce.orders (customer_id);
CREATE INDEX idx_orders_status ON commerce.orders (status);

CREATE TABLE commerce.order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES commerce.orders(id) ON DELETE CASCADE,
  book_id        uuid NOT NULL REFERENCES catalog.books(id),
  title_snapshot text NOT NULL,
  unit_price     numeric(10,2) NOT NULL,
  currency       char(3) NOT NULL DEFAULT 'INR',
  quantity       integer NOT NULL,
  CONSTRAINT order_items_quantity_positive CHECK (quantity > 0),
  CONSTRAINT order_items_unit_price_nonnegative CHECK (unit_price >= 0)
);
CREATE INDEX idx_order_items_order_id ON commerce.order_items (order_id);

-- ---------------------------------------------------------------------
-- Payments — SPEC-06 "Payment": "Razorpay creates payment order.
-- Webhook verification is mandatory before marking an order Paid.
-- Browser callbacks are advisory only." idempotency_key enforces
-- SPEC-06's "Idempotent payment processing" principle at the DB level,
-- not just in application logic — a retried/duplicated webhook
-- delivery for the same Razorpay event can't create a second row.
--
-- `provider` is free text with no hardcoded list (default 'razorpay')
-- so puthagakadai.sg's zero-gateway 'pay_later' option needed no new
-- enum value here — just razorpay_order_id going nullable (migration
-- 20260401000009), since a pay_later row has no Razorpay order to
-- reference.
-- ---------------------------------------------------------------------

CREATE TYPE commerce.payment_status AS ENUM ('created', 'captured', 'failed', 'refunded');

CREATE TABLE commerce.payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES commerce.orders(id),
  provider           text NOT NULL DEFAULT 'razorpay',
  razorpay_order_id  text,                  -- NULL for provider='pay_later'; see migration 20260401000009
  razorpay_payment_id text,
  razorpay_signature text,
  amount             numeric(10,2) NOT NULL,
  currency           char(3) NOT NULL DEFAULT 'INR',
  status             commerce.payment_status NOT NULL DEFAULT 'created',
  idempotency_key    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payments_idempotency_key_unique UNIQUE (idempotency_key),
  CONSTRAINT payments_amount_nonnegative CHECK (amount >= 0)
);
CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON commerce.payments
  FOR EACH ROW EXECUTE FUNCTION commerce.set_updated_at();
CREATE INDEX idx_payments_order_id ON commerce.payments (order_id);
CREATE INDEX idx_payments_razorpay_order_id ON commerce.payments (razorpay_order_id);

-- ---------------------------------------------------------------------
-- Shipments + refunds.
-- ---------------------------------------------------------------------

CREATE TYPE commerce.shipment_status AS ENUM ('pending', 'shipped', 'delivered');

CREATE TABLE commerce.shipments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL REFERENCES commerce.orders(id),
  carrier          text,
  tracking_number  text,
  status           commerce.shipment_status NOT NULL DEFAULT 'pending',
  shipped_at       timestamptz,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_shipments_order_id ON commerce.shipments (order_id);

CREATE TYPE commerce.refund_status AS ENUM ('initiated', 'processed', 'failed');

CREATE TABLE commerce.refunds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES commerce.orders(id),
  payment_id         uuid NOT NULL REFERENCES commerce.payments(id),
  razorpay_refund_id text,
  amount             numeric(10,2) NOT NULL,
  reason             text,
  status             commerce.refund_status NOT NULL DEFAULT 'initiated',
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_amount_positive CHECK (amount > 0)
);
CREATE INDEX idx_refunds_order_id ON commerce.refunds (order_id);
