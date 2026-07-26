-- Up Migration
-- Directus's own internal bootstrap crashed partway through its
-- built-in migration sequence during earlier failed boot attempts
-- (Directus 11.17.4/12.1.1 — see apps/directus/README.md's "Known
-- issue"), leaving partial directus_* system tables behind in the
-- `directus` schema. A subsequent boot (now pinned to 10.13.4) sees
-- those partial tables and refuses to run a fresh install at all,
-- erroring "Database is already installed" instead of either
-- completing the install or detecting the broken state — a known
-- Directus bug pattern (directus/directus#26625: a crashed first
-- migration leaves exactly this "already installed" false signal for
-- every subsequent boot).
--
-- `directus` has never successfully bootstrapped end-to-end, so there
-- is no real editorial content to lose here — safe to wipe and let the
-- next boot attempt a genuinely fresh install. CASCADE only reaches
-- objects inside this one dedicated schema (created by migration
-- 20260101000006_directus_app_role.sql) — catalog/staging/every other
-- schema, and the directus_app role itself (and its catalog/staging
-- grants), are untouched.

DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;

-- Down Migration
-- Not a true inverse — there is no prior state worth restoring (that's
-- the whole point of "up"). Down repeats the same reset so re-running
-- this migration's "down" then "up" again is at least idempotent,
-- rather than a no-op that leaves whatever's currently in `directus`
-- behind.

DROP SCHEMA IF EXISTS directus CASCADE;
CREATE SCHEMA directus;
GRANT ALL ON SCHEMA directus TO directus_app;
