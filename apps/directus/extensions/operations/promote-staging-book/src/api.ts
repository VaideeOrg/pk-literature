import { defineOperationApi } from '@directus/extensions-sdk';
import type { Knex } from 'knex';

type Options = {
	stagingBookId: string;
};

type StagingBook = {
	id: string;
	publisher_id: string;
	isbn13: string | null;
	title: string | null;
	subtitle: string | null;
	author_names: string[] | null;
	description: string | null;
	language: string | null;
	price: string | null;
	currency: string | null;
	stock: number | null;
	publication_date: string | null;
	edition_label: string | null;
	page_count: number | null;
	matched_work_id: string | null;
	matched_book_id: string | null;
	status: string;
	promoted_work_id: string | null;
	promoted_book_id: string | null;
};

/**
 * Resolves each staging author name to a catalog.authors row (case-
 * insensitive exact match on canonical_name; creates one if none
 * exists) and links them to the work via catalog.work_authors. Only
 * used on the create-new path - an existing matched work already has
 * its own author links, which an editor manages directly in the
 * Directus UI rather than this operation silently rewriting them.
 */
async function linkAuthors(trx: Knex.Transaction, workId: string, authorNames: string[]): Promise<void> {
	for (const [index, rawName] of authorNames.entries()) {
		const name = rawName.trim();
		if (!name) continue;

		const existing = await trx('catalog.authors')
			.whereRaw('lower(canonical_name) = lower(?)', [name])
			.first('id');

		const authorId =
			existing?.id ??
			(await trx('catalog.authors').insert({ canonical_name: name }).returning('id'))[0].id;

		await trx('catalog.work_authors')
			.insert({ work_id: workId, author_id: authorId, role: 'author', sort_order: index })
			.onConflict(['work_id', 'author_id', 'role'])
			.ignore();
	}
}

export default defineOperationApi<Options>({
	id: 'promote-staging-book',

	handler: async ({ stagingBookId }, { database, logger, accountability }) => {
		return database.transaction(async (trx) => {
			const stagingBook: StagingBook | undefined = await trx('staging.staging_books')
				.where({ id: stagingBookId })
				.first();

			if (!stagingBook) {
				throw new Error(`staging_book ${stagingBookId} not found`);
			}

			// Idempotency guard: also covers the case where a Flow
			// re-fires on a staging_book that's already 'merged' (e.g.
			// status re-set to 'approved' by mistake after promotion) -
			// promoted_book_id being set is the source of truth, not
			// status alone.
			if (stagingBook.promoted_book_id) {
				logger.info(
					`staging_book ${stagingBookId} already promoted to book ${stagingBook.promoted_book_id} - skipping`,
				);
				return { skipped: true, workId: stagingBook.promoted_work_id, bookId: stagingBook.promoted_book_id };
			}

			if (stagingBook.status !== 'approved') {
				throw new Error(
					`staging_book ${stagingBookId} is not approved (status=${stagingBook.status}) - refusing to promote`,
				);
			}

			const hasMatch = Boolean(stagingBook.matched_work_id && stagingBook.matched_book_id);

			let workId: string;
			let bookId: string;

			if (hasMatch) {
				// Merge: staging value wins per field when non-null,
				// existing catalog value survives where staging has
				// nothing (COALESCE(staging, existing), not a blind
				// overwrite - see plan/specs/spec-04's Merge Rules and
				// the "always merge for matched items" decision this
				// operation implements).
				workId = stagingBook.matched_work_id!;
				bookId = stagingBook.matched_book_id!;

				await trx.raw(
					`
					UPDATE catalog.works w
					SET canonical_title = COALESCE(?, w.canonical_title),
					    original_language = COALESCE(?, w.original_language),
					    summary = COALESCE(?, w.summary)
					WHERE w.id = ?
					`,
					[stagingBook.title, stagingBook.language, stagingBook.description, workId],
				);

				await trx.raw(
					`
					UPDATE catalog.books b
					SET publisher_id = COALESCE(?, b.publisher_id),
					    isbn13 = COALESCE(?, b.isbn13),
					    title = COALESCE(?, b.title),
					    subtitle = COALESCE(?, b.subtitle),
					    language = COALESCE(?, b.language),
					    edition_label = COALESCE(?, b.edition_label),
					    page_count = COALESCE(?, b.page_count),
					    publication_date = COALESCE(?, b.publication_date)
					WHERE b.id = ?
					`,
					[
						stagingBook.publisher_id,
						stagingBook.isbn13,
						stagingBook.title,
						stagingBook.subtitle,
						stagingBook.language,
						stagingBook.edition_label,
						stagingBook.page_count,
						stagingBook.publication_date,
						bookId,
					],
				);
			} else {
				// Create new. work_type/canonical_title_translit/
				// first_publication_year have no staging equivalent -
				// left at their column defaults (or null) for an
				// editor to fill in later; this operation's job is to
				// get the row to exist at 'draft', not to fully curate
				// it.
				if (!stagingBook.title) {
					throw new Error(`staging_book ${stagingBookId} has no title - cannot create a catalog Work/Book`);
				}
				if (!stagingBook.language) {
					throw new Error(`staging_book ${stagingBookId} has no language - cannot create a catalog Work`);
				}

				const [work] = await trx('catalog.works')
					.insert({
						canonical_title: stagingBook.title,
						original_language: stagingBook.language,
						summary: stagingBook.description,
					})
					.returning('id');
				workId = work.id;

				if (stagingBook.author_names?.length) {
					await linkAuthors(trx, workId, stagingBook.author_names);
				}

				const [book] = await trx('catalog.books')
					.insert({
						work_id: workId,
						publisher_id: stagingBook.publisher_id,
						isbn13: stagingBook.isbn13,
						title: stagingBook.title,
						subtitle: stagingBook.subtitle,
						language: stagingBook.language,
						edition_label: stagingBook.edition_label,
						page_count: stagingBook.page_count,
						publication_date: stagingBook.publication_date,
					})
					.returning('id');
				bookId = book.id;
			}

			// TODO(follow-up, not yet built): media promotion
			// (staging_media -> catalog.media_assets + S3 copy from the
			// staging/ prefix, then books.cover_asset_id), inventory
			// promotion (staging_inventory -> catalog.inventory), and
			// relationship promotion (staging_relationships ->
			// work_themes/work_genres/work_literary_movements/
			// book_collections - blocked on those junction tables
			// getting surrogate primary keys first, same gap noted
			// during the bootstrap.ts work).
			// accountability.user is the editor who triggered the Flow
			// (the same one who set status -> 'approved', given today's
			// automatic-on-approval trigger) - null for a non-user-
			// initiated run (e.g. manually testing this operation
			// directly via the Flow's "Test" button with no
			// accountability context), in which case promoted_by stays
			// null rather than the promotion failing outright.
			await trx('staging.staging_books').where({ id: stagingBookId }).update({
				status: 'merged',
				promoted_work_id: workId,
				promoted_book_id: bookId,
				promoted_by: accountability?.user ?? null,
				promoted_at: trx.fn.now(),
			});

			logger.info(
				`staging_book ${stagingBookId} promoted to work ${workId} / book ${bookId} (${hasMatch ? 'merged into existing' : 'created new'})`,
			);

			return { skipped: false, workId, bookId, created: !hasMatch };
		});
	},
});
