-- Up Migration
-- Diagnostic only, deliberately fails so it surfaces in
-- migration-runner's own invoke response (its stdout doesn't reach us
-- otherwise) and never gets marked as applied - safe to re-run.
-- 20260101000016's fix isn't taking effect (GET /users/me still
-- returns only `id` for this user, even after a forced ECS
-- redeployment ruled out stale in-memory cache) - need to see the
-- actual current DB state rather than guess again.
DO $$
DECLARE
  v_report text;
BEGIN
  SELECT format(
    'user.role=%s | role.name=%s | policy_count=%s | policies=%s',
    u.role,
    r.name,
    (SELECT count(*) FROM directus_access a WHERE a.role = u.role OR a.user = u.id),
    (SELECT string_agg(format('%s(admin=%s)', p.name, p.admin_access), ', ')
     FROM directus_access a
     JOIN directus_policies p ON p.id = a.policy
     WHERE a.role = u.role OR a.user = u.id)
  ) INTO v_report
  FROM directus_users u
  LEFT JOIN directus_roles r ON r.id = u.role
  WHERE u.id = 'de520ea8-b27a-4e49-a26a-62ed31899d98';

  RAISE EXCEPTION 'DIAGNOSTIC: %', v_report;
END
$$;

-- Down Migration
-- N/A - this migration is designed to always fail and never apply.
