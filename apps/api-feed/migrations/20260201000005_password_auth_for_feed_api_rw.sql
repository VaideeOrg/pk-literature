-- Up Migration
-- Switches feed_api_rw from RDS Proxy IAM auth back to a stored
-- password — see api-catalog's 20260101000010_password_auth_for_iam_roles.sql
-- for the full reasoning (reverting 20260201000004_grant_rds_iam.sql).

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rds_iam') THEN
    REVOKE rds_iam FROM feed_api_rw;
  END IF;
END
$$;

-- Down Migration

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO feed_api_rw;
  END IF;
END
$$;
