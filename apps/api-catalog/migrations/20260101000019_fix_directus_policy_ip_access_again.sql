-- Up Migration
-- Recurrence of the exact issue 20260101000018 fixed. Root cause
-- finally understood: Directus's own container-startup bootstrap
-- (`node cli.js bootstrap`, baked into the image's default CMD) runs
-- on every single container boot, and per 20260101000016's own
-- header comment, has a documented history of re-touching this
-- account's role assignment on restart. A force-new-deployment done
-- live to pick up enable_execute_command (see the ECS Exec Terraform
-- change) triggered exactly that: the account's role silently
-- flipped from the "Full Administrator (restored)" role
-- 20260101000016 pointed it at back to Directus's own default
-- "Administrator" role - a role never covered by the ip_access fix
-- before, because it didn't exist as this account's role at the time.
--
-- Confirmed live via a raw query run directly inside the container
-- against this same database (through ECS Exec, bypassing the API
-- entirely): the newly-(re)assigned "Administrator" policy has
-- ip_access = '0.0.0.0/0' - a non-null value, so
-- fetch-global-access-for-query.ts's `if (accountability.ip &&
-- ip_access)` check runs its network-match test on it at all (unlike
-- NULL, which always skips that check outright and is the only value
-- confirmed reliable so far). Rather than debug why a
-- theoretically-universal /0 CIDR might be failing to match in this
-- runtime, just apply the exact same known-good fix again.
--
-- Same query as 20260101000018, deliberately not hardcoded to a
-- specific policy ID - it looks up the user's CURRENT role dynamically
-- via subquery, so it catches whichever role/policies are actually
-- attached right now, including this new one.
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
-- access gap this migration exists to fix, same reasoning as
-- 20260101000018's down migration.
