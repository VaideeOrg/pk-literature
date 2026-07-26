-- Up Migration
-- directus_app's search_path was scoped to `directus` only (migration
-- 20260101000006_directus_app_role.sql), excluding `public`. This
-- matches a documented Directus limitation: when the connection's
-- search_path is a custom schema only (not including `public`),
-- Directus creates its own system tables fine but then fails to
-- find/use them afterward — a real, reported failure mode for
-- non-public-schema Postgres deployments. This is a plausible root
-- cause for both bootstrap failures seen so far: Directus 11.17.4
-- crashing mid-migration (20251014A-add-project-owner) and 10.13.4
-- installing its system tables successfully but then failing at
-- runSeed with "Database is already installed" — both are "Directus
-- looking for/using its own tables inconsistently" symptoms.
--
-- Adding `public` after `directus` keeps `directus`'s own objects
-- created there first (unqualified CREATE TABLE still lands in
-- `directus`, the first schema in the path), while making `public`
-- visible as a fallback for whatever internal Directus queries assume
-- it. This does NOT grant directus_app any new privileges on `public`
-- beyond what every role already gets by default in this database (no
-- REVOKE PUBLIC has been run against it) — it only adds `public` to
-- directus_app's own name-resolution search path.
ALTER ROLE directus_app SET search_path TO directus, public;

-- 10.13.4's last boot attempt (installing system tables, then failing
-- at runSeed) left the same kind of partial state migration
-- 20260101000011 reset before — the next boot needs another genuinely
-- empty `directus` schema to test the search_path change fairly, for
-- the same reasons documented there.
DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;

-- Down Migration
-- Reverts the search_path to its original (directus-only) scope. Also
-- resets `directus` again — same "no prior state worth restoring"
-- reasoning as migration 20260101000011's own down.
ALTER ROLE directus_app SET search_path TO directus;

DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;
