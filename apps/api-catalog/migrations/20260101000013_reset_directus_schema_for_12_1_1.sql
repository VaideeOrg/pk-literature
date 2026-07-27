-- Up Migration
-- 10.13.4's last boot attempt (installing its own system tables, then
-- crashing at runSeed's "Database is already installed" false
-- positive — see apps/directus/README.md's "Known issue") left the
-- `directus` schema in the same kind of partial state migrations
-- 20260101000011/20260101000012 already reset before. Now trying
-- 12.1.1 (with the eventbridge-put-event extension's host range
-- widened to accept it) — the next boot needs another genuinely empty
-- `directus` schema to test that fairly, for the same reasons
-- documented in those two migrations.
DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;

-- Down Migration
-- Same "no prior state worth restoring" reasoning as
-- 20260101000011/20260101000012's own down migrations.
DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;
