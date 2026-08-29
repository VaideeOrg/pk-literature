import { defineOperationApi } from '@directus/extensions-sdk';
import { S3Client, CopyObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

// One client per container lifetime, same reasoning as the
// eventbridge-put-event extension's EventBridgeClient - region/
// credentials come from the ECS task's own environment (Directus's
// task role, which already has s3:GetObject/PutObject on this bucket
// per directus.tf's directus_task IAM policy - s3:CopyObject needs no
// separate grant, it's authorized via the same Get+Put actions on
// source and destination).
const s3 = new S3Client({});

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

/**
 * Promotes the most recently uploaded staging_media row (if any) for
 * this staging book: copies the S3 object from its staging/ prefix to
 * a permanent covers/ key (media-storage.service.ts's own header
 * comment documents this exact staging/->covers/ split, so a rejected
 * staging book's never-reviewed cover is never reachable via the same
 * key an approved one would use), creates/updates the matching
 * catalog.media_assets row, and points books.cover_asset_id at it.
 *
 * Runs for both the create-new and merge paths - a re-crawl that
 * turns up a newer/better cover should replace an existing one, same
 * "staging wins when present" philosophy as every other merged field.
 * No-ops silently if there's no successfully uploaded staging_media
 * row (most staging books won't have one yet, or the cover download
 * step failed) - a book without a cover is a valid, unremarkable
 * state, not an error.
 *
 * Deliberately does NOT delete the staging/ S3 object after copying -
 * leaves a harmless duplicate rather than risking data loss if
 * anything downstream of this operation fails. Cleanup of stale
 * staging/ objects, if wanted, belongs in an S3 lifecycle rule (same
 * pattern as terraform/modules/lambda-artifacts' 90-day expiration),
 * not here.
 */
async function promoteMedia(
	trx: Knex.Transaction,
	env: Record<string, any>,
	logger: { warn: (msg: string) => void },
	stagingBookId: string,
	bookId: string,
): Promise<void> {
	const media = await trx('staging.staging_media')
		.where({ staging_book_id: stagingBookId, status: 'uploaded' })
		.whereNotNull('s3_key')
		.orderBy('created_at', 'desc')
		.first();

	if (!media) {
		return;
	}

	const bucket = env['STORAGE_S3_BUCKET'];
	if (!bucket) {
		logger.warn(`STORAGE_S3_BUCKET not set - skipping media promotion for staging_book ${stagingBookId}`);
		return;
	}

	const destKey = `covers/${bookId}/cover-original`;

	await s3.send(
		new CopyObjectCommand({
			Bucket: bucket,
			CopySource: `${bucket}/${media.s3_key}`,
			Key: destKey,
			MetadataDirective: 'COPY',
		}),
	);

	// MetadataDirective: 'COPY' preserves the original ContentType set
	// at upload time (media-storage.service.ts's PutObjectCommand) -
	// read it back rather than guessing, since catalog.media_assets.
	// content_type is NOT NULL.
	const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: destKey }));
	const contentType = head.ContentType ?? 'application/octet-stream';

	const [asset] = await trx('catalog.media_assets')
		.insert({
			asset_type: 'cover',
			s3_key: destKey,
			content_type: contentType,
			checksum_sha256: media.checksum_sha256,
			source_url: media.source_url,
		})
		.onConflict('s3_key')
		.merge(['content_type', 'checksum_sha256', 'source_url'])
		.returning('id');

	// cover_s3_key (migration 20260101000024) is a denormalized copy of
	// destKey, kept in sync alongside cover_asset_id - see that
	// migration's own comment for why (Directus's Table/Card layouts
	// can't render a thumbnail from a related collection's field, the
	// same reasoning staging_books.cover_s3_key already goes on).
	await trx('catalog.books').where({ id: bookId }).update({ cover_asset_id: asset.id, cover_s3_key: destKey });
}

/**
 * Upserts catalog.inventory from staging_books' own price/stock/
 * currency columns (the "current" snapshot the import pipeline writes
 * per book) - not staging.staging_inventory, which is a separate,
 * multi-row-per-book table that reads more like a historical capture
 * log (captured_at, no upsert-friendly shape) than "the current
 * truth"; nothing in this repo populates it today, and conflating the
 * two would need a real decision about which one wins that isn't
 * this operation's to make.
 *
 * catalog.inventory.price is NOT NULL, so this silently no-ops when
 * staging has no price yet (a real, unremarkable state - e.g. a
 * rejected or not-yet-fully-crawled staging book) rather than failing
 * the whole promotion over a missing price.
 */
async function promoteInventory(trx: Knex.Transaction, stagingBook: StagingBook, bookId: string): Promise<void> {
	if (stagingBook.price == null) {
		return;
	}

	await trx('catalog.inventory')
		.insert({
			book_id: bookId,
			stock: stagingBook.stock ?? 0,
			price: stagingBook.price,
			currency: stagingBook.currency ?? 'INR',
			availability: (stagingBook.stock ?? 0) > 0 ? 'in_stock' : 'out_of_stock',
			updated_by: 'adapter',
			last_sync_time: trx.fn.now(),
		})
		.onConflict('book_id')
		.merge(['stock', 'price', 'currency', 'availability', 'updated_by', 'last_sync_time']);
}

const RELATIONSHIP_TARGETS: Record<
	string,
	{ scope: 'work' | 'book'; junctionTable: string; targetColumn: string; lookupTable: string }
> = {
	theme: { scope: 'work', junctionTable: 'catalog.work_themes', targetColumn: 'theme_id', lookupTable: 'catalog.themes' },
	genre: { scope: 'work', junctionTable: 'catalog.work_genres', targetColumn: 'genre_id', lookupTable: 'catalog.genres' },
	literary_movement: {
		scope: 'work',
		junctionTable: 'catalog.work_literary_movements',
		targetColumn: 'literary_movement_id',
		lookupTable: 'catalog.literary_movements',
	},
	collection: {
		scope: 'book',
		junctionTable: 'catalog.book_collections',
		targetColumn: 'collection_id',
		lookupTable: 'catalog.collections',
	},
};

/**
 * Promotes staging_relationships rows into the corresponding catalog
 * M:N junction table (work_themes/work_genres/work_literary_movements
 * for Work-scoped relationships, book_collections for Book-scoped).
 *
 * UNVERIFIED, more so than anything else in this operation: nothing
 * in this repo (grepped apps/api-publisher-import and packages/
 * adapter-sdk in full) actually writes to staging_relationships today
 * - no adapter populates it, so relationship_type's real string
 * vocabulary has never been observed, only guessed at here
 * ('theme'/'genre'/'literary_movement'/'collection', matching the
 * catalog concepts staging_relationships.target_label most plausibly
 * refers to). Confirm against whatever an adapter eventually writes
 * before trusting this in production - an unrecognized
 * relationship_type is logged and skipped, not treated as an error,
 * specifically because this mapping is a guess.
 *
 * Lookup-only for themes/genres/literary_movements/collections -
 * deliberately does NOT auto-create a new one from an unmatched
 * target_label the way linkAuthors() does for authors. Those four are
 * curated taxonomies an editor defines, not an open set like author
 * names - auto-expanding them from noisy crawled label text would
 * pollute the taxonomy. Unmatched labels are logged and skipped.
 */
async function promoteRelationships(
	trx: Knex.Transaction,
	logger: { warn: (msg: string) => void },
	stagingBookId: string,
	workId: string,
	bookId: string,
): Promise<void> {
	const relationships = await trx('staging.staging_relationships').where({ staging_book_id: stagingBookId });

	for (const rel of relationships) {
		const target = RELATIONSHIP_TARGETS[rel.relationship_type];
		if (!target) {
			logger.warn(
				`staging_relationships row ${rel.id}: unrecognized relationship_type "${rel.relationship_type}" - skipping`,
			);
			continue;
		}

		let targetId: string | null = rel.target_id ?? null;
		if (!targetId) {
			const found = await trx(target.lookupTable)
				.whereRaw('lower(name) = lower(?)', [rel.target_label])
				.first('id');
			targetId = found?.id ?? null;
		}

		if (!targetId) {
			logger.warn(
				`staging_relationships row ${rel.id}: no catalog ${target.lookupTable} match for "${rel.target_label}" - skipping`,
			);
			continue;
		}

		const parentId = target.scope === 'work' ? workId : bookId;
		const parentColumn = target.scope === 'work' ? 'work_id' : 'book_id';

		await trx(target.junctionTable)
			.insert({ [parentColumn]: parentId, [target.targetColumn]: targetId })
			.onConflict([parentColumn, target.targetColumn])
			.ignore();
	}
}

export default defineOperationApi<Options>({
	id: 'promote-staging-book',

	handler: async ({ stagingBookId }, { database, logger, accountability, env }) => {
		return database.transaction(async (trx) => {
			const stagingBook: StagingBook | undefined = await trx('staging.staging_books')
				.where({ id: stagingBookId })
				.first();

			if (!stagingBook) {
				throw new Error(`staging_book ${stagingBookId} not found`);
			}

			// Idempotency guard: also covers the case where a Flow
			// re-fires on a staging_book that's already 'promoted' (e.g.
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

			await promoteMedia(trx, env, logger, stagingBookId, bookId);
			await promoteInventory(trx, stagingBook, bookId);
			await promoteRelationships(trx, logger, stagingBookId, workId, bookId);

			// accountability.user is the editor who triggered the Flow
			// (the same one who set status -> 'approved', given today's
			// automatic-on-approval trigger) - null for a non-user-
			// initiated run (e.g. manually testing this operation
			// directly via the Flow's "Test" button with no
			// accountability context), in which case promoted_by stays
			// null rather than the promotion failing outright.
			await trx('staging.staging_books').where({ id: stagingBookId }).update({
				status: 'promoted',
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
