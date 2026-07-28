-- Up Migration
-- migration-runner's migrations are tracked/one-time (each runs at most
-- once) - invoking it again after the RDS-Proxy-bypass + DB_SSL__CA_FILE
-- fixes landed did NOT re-run 20260101000013's reset, since that
-- migration had already executed during the earlier (RDS-Proxy, wrong
-- DB_SSL__CA) attempt. Confirmed live: that invocation returned
-- migrationsRun: [] for every service, and the very next Directus boot
-- hit the identical "Installing Directus system tables..." then
-- "Database is already installed" crash - not fresh evidence about the
-- RDS-Proxy-bypass hypothesis, since it ran against whatever partial
-- state that earlier crashed attempt already left behind.
--
-- Testing Directus against RDS directly (bypassing RDS Proxy, with a
-- working CA bundle this time) needs its own genuinely empty `directus`
-- schema to be a fair test, for the same reasons documented in
-- 20260101000011/20260101000012/20260101000013.
DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;

-- Down Migration
-- Same "no prior state worth restoring" reasoning as
-- 20260101000011/20260101000012/20260101000013's own down migrations.
DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;
