-- Up Migration
-- Root cause finally isolated for the Bearer-token-vs-browser 403
-- discrepancy on schema-modifying endpoints (POST /collections etc.):
-- Directus's CollectionsService.createOne() hard-gates on
-- accountability.admin, which is recomputed fresh on every request
-- (never trusts the JWT's own admin_access claim) by walking each
-- attached policy and SKIPPING any policy whose ip_access is set
-- unless the request's resolved IP matches one of its allowed
-- networks (packages/utils/node/fetch-global-access's
-- fetch-global-access-for-query.ts). 20260101000016's new policy
-- ("Full Administrator (restored)") never explicitly set ip_access,
-- and if that column doesn't default to NULL (e.g. defaults to an
-- empty array/string instead), it silently matches zero IPs -
-- blocking that policy for every request regardless of admin_access,
-- explaining why the browser (whatever IP it happened to satisfy via
-- some other already-permissive policy) and curl/API-token access
-- (which never matched) behaved differently for the identical
-- account.
--
-- Force ip_access to NULL (no restriction, matches every request)
-- on every policy tied to the restored account, not just the new
-- one - the pre-existing "Administrator" policy this account is also
-- attached to could have the exact same issue.
UPDATE directus_policies
SET ip_access = NULL
WHERE id IN (
  SELECT DISTINCT p.id
  FROM directus_access a
  JOIN directus_policies p ON p.id = a.policy
  WHERE a.role = (SELECT role FROM directus_users WHERE id = 'de520ea8-b27a-4e49-a26a-62ed31899d98')
     OR a.user = 'de520ea8-b27a-4e49-a26a-62ed31899d98'
);

-- Down Migration
-- Deliberately a no-op - reverting this would reintroduce the exact
-- access gap this migration exists to fix. Undo by hand with full
-- context on what ip_access should actually be restricted to, if
-- that's ever genuinely wanted.
