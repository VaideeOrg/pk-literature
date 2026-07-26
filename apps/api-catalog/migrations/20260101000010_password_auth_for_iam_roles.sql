-- Up Migration
-- Switches catalog_api_readonly and publisher_import_writer from RDS
-- Proxy IAM auth back to a stored password, same as directus_app/
-- medusa_app already use (infrastructure/secrets.md's stored-password
-- exception, now extended to these two roles as well).
--
-- Reverts 20260101000008_grant_rds_iam.sql's GRANT rds_iam for these
-- two roles specifically. That grant is what forces RDS's own
-- pg_hba.conf to accept ONLY IAM-token auth for a role — group
-- membership matches pg_hba's "+rds_iam ... iam" rule ahead of any
-- password-based rule, regardless of whether a real password is also
-- set. "Standard" RDS Proxy IAM auth (client-to-proxy IAM, proxy-to-
-- backend via a stored secret) and "end-to-end" IAM auth
-- (default_auth_scheme = IAM_AUTH, proxy-to-backend also via IAM) were
-- both tried against these roles for real and abandoned — the latter
-- hit "PAM authentication failed", then "Connection terminated
-- unexpectedly" even after adding the proxy's own rds-db:connect grant,
-- with no further AWS documentation found confirming a shared-proxy,
-- multiple-distinct-target-role topology like this one is actually
-- supported end-to-end yet.
--
-- The actual password value is set separately by
-- apps/migration-runner's own sync-role-passwords step (reads each
-- role's real value from Secrets Manager and runs ALTER ROLE ...
-- PASSWORD directly — never a plain-text value in a checked-in
-- migration file), not by this migration.

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rds_iam') THEN
    REVOKE rds_iam FROM catalog_api_readonly;
    REVOKE rds_iam FROM publisher_import_writer;
  END IF;
END
$$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO catalog_api_readonly;
    GRANT rds_iam TO publisher_import_writer;
  END IF;
END
$$;
