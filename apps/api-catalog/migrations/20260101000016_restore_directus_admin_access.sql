-- Up Migration
-- Live incident recovery. Directus's own container bootstrap
-- (ADMIN_EMAIL/ADMIN_PASSWORD) created the first admin correctly, but
-- the ECS task crash-looped extensively before the ALB health-check-
-- path fix (see security-groups/alb health_check_path history) - at
-- least one restart re-ran Directus's own bootstrap logic and created
-- a second role/policy pair, both visibly named "Administrator" in the
-- admin UI. Deleting the extra one (done manually, live, in the admin
-- UI) turned out to have deleted the wrong one: user
-- de520ea8-b27a-4e49-a26a-62ed31899d98 (the account that previously
-- had confirmed full working admin access - GET /users, /roles,
-- /policies all 200/304 in a real logged session) now returns almost
-- no readable fields on GET /users/me, meaning its role reference is
-- now null or points at a policy without admin_access.
--
-- Rather than guess at repairing whatever's left of the old
-- "Administrator" role/policy pair (unknown current state, and a
-- second attempt to fix this via Directus's own `users create` CLI
-- failed outright - `--role Administrator` is parsed as a literal
-- role UUID, not a name lookup, so it never even created a row), this
-- creates a brand new, unambiguously-named policy + role and points
-- the known-good user directly at it.
DO $$
DECLARE
  v_policy_id uuid;
  v_role_id uuid;
BEGIN
  SELECT id INTO v_policy_id FROM directus_policies WHERE name = 'Full Administrator (restored)';
  IF v_policy_id IS NULL THEN
    v_policy_id := gen_random_uuid();
    INSERT INTO directus_policies (id, name, icon, admin_access, app_access)
    VALUES (v_policy_id, 'Full Administrator (restored)', 'verified', true, true);
  END IF;

  SELECT id INTO v_role_id FROM directus_roles WHERE name = 'Full Administrator (restored)';
  IF v_role_id IS NULL THEN
    v_role_id := gen_random_uuid();
    INSERT INTO directus_roles (id, name, icon) VALUES (v_role_id, 'Full Administrator (restored)', 'verified');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM directus_access WHERE role = v_role_id AND policy = v_policy_id) THEN
    INSERT INTO directus_access (id, role, policy) VALUES (gen_random_uuid(), v_role_id, v_policy_id);
  END IF;

  UPDATE directus_users SET role = v_role_id WHERE id = 'de520ea8-b27a-4e49-a26a-62ed31899d98';
END
$$;

-- Down Migration
-- Deliberately a no-op: reverting this would set the account's role
-- back to null/broken, which is the exact state this migration exists
-- to fix. If this ever needs undoing, do it by hand with full context
-- on what the account's role should actually be at that time.
