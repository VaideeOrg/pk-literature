import { defineOperationApp } from '@directus/extensions-sdk';

export default defineOperationApp({
	id: 'decrement-inventory-stock',
	name: 'Decrement Inventory Stock',
	icon: 'remove_shopping_cart',
	description:
		'Atomically decrement catalog.inventory.stock for a list of {bookId, quantity} line items - never goes below zero. Gated by a shared secret (INVENTORY_WEBHOOK_SECRET), since this Flow is triggered by an unauthenticated webhook endpoint by design.',
	overview: ({ items }) => [{ label: 'Items', text: typeof items === 'string' ? items : JSON.stringify(items) }],
	options: [
		{
			field: 'secret',
			name: 'Shared Secret',
			type: 'string',
			meta: {
				width: 'full',
				interface: 'input',
				note: 'Compared against INVENTORY_WEBHOOK_SECRET. Wire this to the incoming webhook request body\'s secret field.',
				options: { placeholder: '{{$trigger.body.secret}}' },
			},
		},
		{
			field: 'items',
			name: 'Items',
			type: 'json',
			meta: {
				width: 'full',
				interface: 'input-code',
				note: 'Array of {bookId, quantity} - wire this to the incoming webhook request body\'s items field.',
				options: { language: 'json', placeholder: '{{$trigger.body.items}}' },
			},
		},
	],
});
