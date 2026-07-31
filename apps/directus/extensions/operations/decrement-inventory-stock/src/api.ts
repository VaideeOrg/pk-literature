import { defineOperationApi } from '@directus/extensions-sdk';
import type { Knex } from 'knex';

type Options = {
	secret: string;
	items: unknown;
};

type Item = { bookId: string; quantity: number };

function parseItems(raw: unknown): Item[] {
	const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
	if (!Array.isArray(value)) {
		throw new Error('items must be an array of {bookId, quantity}');
	}
	return value.map((item) => {
		if (typeof item?.bookId !== 'string' || typeof item?.quantity !== 'number' || item.quantity <= 0) {
			throw new Error(`invalid item: ${JSON.stringify(item)}`);
		}
		return { bookId: item.bookId, quantity: item.quantity };
	});
}

// Gated by a shared secret rather than Directus's own accountability/
// role system - this operation runs with Directus's own DB connection
// (context.database) regardless of who or what triggered the Flow,
// the same way promote-staging-book's writes aren't scoped by the
// triggering user's own permissions either. That matters more here
// than for promote-staging-book: this Flow's trigger is a webhook,
// and Directus's webhook trigger endpoints are reachable without
// authentication by design (that's their whole purpose - accepting
// arbitrary third-party callers) - INVENTORY_WEBHOOK_SECRET is what
// actually gates who can decrement stock, not Directus's own auth.
export default defineOperationApi<Options>({
	id: 'decrement-inventory-stock',

	handler: async ({ secret, items }, { database, logger, env }) => {
		const expected = env['INVENTORY_WEBHOOK_SECRET'];
		if (!expected || secret !== expected) {
			throw new Error('decrement-inventory-stock: invalid or missing shared secret');
		}

		const parsedItems = parseItems(items);

		await database.transaction(async (trx: Knex.Transaction) => {
			for (const item of parsedItems) {
				// GREATEST(...) never lets stock go negative even under a
				// race between two concurrent decrements for the same book
				// (no reservation/lock exists upstream at checkout time) -
				// availability only flips to 'out_of_stock' on the
				// transition that actually hits zero; a book already at
				// 'preorder'/'discontinued' isn't silently overwritten by
				// a decrement that still leaves stock > 0.
				await trx.raw(
					`
					UPDATE catalog.inventory
					SET stock = GREATEST(stock - ?, 0),
					    availability = CASE WHEN GREATEST(stock - ?, 0) = 0 THEN 'out_of_stock' ELSE availability END
					WHERE book_id = ?
					`,
					[item.quantity, item.quantity, item.bookId],
				);
			}
		});

		logger.info(`decrement-inventory-stock: decremented ${parsedItems.length} item(s)`);
		return { decremented: parsedItems.length };
	},
});
