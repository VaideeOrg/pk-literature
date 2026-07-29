-- Up Migration
-- Was originally diagnostic-only and designed to always fail (RAISE
-- EXCEPTION), so its output would surface in migration-runner's own
-- invoke response - it did its job (found the account's role/policies
-- were actually correct, which pointed the real investigation at the
-- IP-allowlist issue migration 20260101000018 fixes). Left permanently
-- failing, it blocks every migration numbered after it from ever
-- running (node-pg-migrate processes migrations in order and stops on
-- the first error) - a real, live-hit oversight: 20260101000018
-- couldn't run at all until this was neutralized. Turned into a no-op
-- so migrations can proceed past it; the diagnostic query and its
-- findings are preserved in the down migration's comment purely as a
-- record, not executed.
SELECT 1;

-- Down Migration
-- No-op - see up migration's comment. The diagnostic query this
-- migration used to run (for reference only, not executed):
--   SELECT u.role, r.name, count(*), string_agg(...)
--   FROM directus_users u ...
--   WHERE u.id = 'de520ea8-b27a-4e49-a26a-62ed31899d98'
-- Findings at the time: role=Full Administrator (restored), 3
-- policies attached (Administrator, $t:public_label, Full
-- Administrator (restored)), all admin_access=true - confirming the
-- account's role/policy assignment was already correct, which is what
-- pointed the investigation at IP allowlisting instead.
SELECT 1;
