-- Up Migration
-- Recurrence of the exact issue 20260101000018 fixed. Root cause: the
-- "Full Administrator (restored)" role 20260101000016 created and
-- pointed this account at was manually deleted via the admin UI
-- during this same live debugging session. Deleting a role a user is
-- currently assigned to forces Directus to reassign that user
-- somewhere - in this case, back to Directus's own default
-- "Administrator" role, which was never covered by the earlier
-- ip_access fix because it wasn't this account's role at the time
-- that fix was written.
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
