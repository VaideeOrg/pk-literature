-- Up Migration
-- Audit trail for the promote-staging-book Flow operation
-- (apps/directus/extensions/operations/promote-staging-book):
-- promoted_work_id/promoted_book_id (20260101000020) record WHAT a
-- staging row turned into; these record WHO triggered that and WHEN.
-- Separate from reviewed_by/reviewed_at (still unused, left available
-- for a future distinct "reviewed" checkpoint - see state-machines/
-- book.md's Senior Editor approval step for the catalog-side
-- equivalent) since the promotion trigger firing automatically on
-- status -> 'approved' means "reviewed" and "promoted" happen to be
-- the same moment today, but aren't guaranteed to stay that way.
--
-- promoted_by is a real FK into directus_users, not a denormalized
-- text field, matching Directus's own user_created/user_updated
-- convention - renders as a proper user picker/avatar in the Admin
-- UI once the field's interface is set, not just a raw UUID or name
-- string. ON DELETE SET NULL: deleting a Directus user account
-- shouldn't cascade-delete promotion history, just orphan the
-- attribution.
ALTER TABLE staging.staging_books
  ADD COLUMN promoted_by uuid REFERENCES public.directus_users(id) ON DELETE SET NULL,
  ADD COLUMN promoted_at timestamptz;

-- Down Migration

ALTER TABLE staging.staging_books
  DROP COLUMN IF EXISTS promoted_at,
  DROP COLUMN IF EXISTS promoted_by;
