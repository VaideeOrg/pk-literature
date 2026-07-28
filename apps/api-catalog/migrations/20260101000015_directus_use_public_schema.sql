-- Up Migration
-- Root cause finally isolated (see apps/directus/README.md's "Known
-- issue" section): Directus's own schema-introspection code
-- (getDatabaseSchema/@directus/schema's schemaInspector.overview())
-- has a long-documented gap with non-`public` Postgres schemas
-- (directus/directus discussion #12057, issues #3228/#24592) - it does
-- not reliably see its own tables when they live outside `public`,
-- even with `public` added to the connecting role's search_path as a
-- fallback (migration 20260101000012, which did not fix this). This
-- reproduced identically across three Directus versions (11.17.4,
-- 10.13.4, 12.1.1) and both RDS Proxy and a direct RDS connection - the
-- one constant across every failed attempt was the dedicated `directus`
-- schema, not the connection path. There is no official override
-- (unlike Medusa's explicit `databaseSchema` config key) - Directus
-- maintainers' documented position is to not run its own tables outside
-- `public`.
--
-- `public` is not used by any other service's migrations in this repo
-- (grepped every apps/*/migrations/*.sql - `catalog`/`staging`/
-- `discovery`/`commerce`/`identity`/`medusa` each have their own
-- dedicated schema, naming.md's schema-per-domain convention), so
-- Directus using it exclusively doesn't collide with anything.
ALTER ROLE directus_app SET search_path TO public;
GRANT ALL ON SCHEMA public TO directus_app;

-- The `directus` schema is no longer used - drop it rather than leave
-- an empty, confusing leftover (nothing else references it).
DROP SCHEMA IF EXISTS directus CASCADE;

-- Down Migration
-- Reverts to the dedicated-schema setup migrations 20260101000006/
-- 20260101000012 established, should this need rolling back.
REVOKE ALL ON SCHEMA public FROM directus_app;
ALTER ROLE directus_app SET search_path TO directus, public;

CREATE SCHEMA IF NOT EXISTS directus;
GRANT ALL ON SCHEMA directus TO directus_app;
