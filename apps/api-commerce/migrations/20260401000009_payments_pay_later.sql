-- Up Migration
-- Relaxes commerce.payments.razorpay_order_id to nullable so a
-- provider='pay_later' row (puthagakadai.sg's zero-gateway "pay on
-- collection" option) can exist without a fabricated Razorpay id.
-- `provider` was already a free-text column with no hardcoded list
-- (default 'razorpay') — this is the one real schema blocker to
-- letting 'pay_later' exist as a row, everything else about modeling
-- pay-later needed no schema change. No new commerce.order_status
-- value yet (e.g. a future 'pending_collection') — that migration is
-- deferred; a pay-later order simply stays 'pending_payment' until a
-- store keeper marks it paid on collection.

ALTER TABLE commerce.payments
  ALTER COLUMN razorpay_order_id DROP NOT NULL;

-- Down Migration
-- Only safe if no pay_later (null razorpay_order_id) rows exist yet;
-- matches this repo's convention of a straightforward symmetric revert
-- rather than a defensive backfill.

ALTER TABLE commerce.payments
  ALTER COLUMN razorpay_order_id SET NOT NULL;
