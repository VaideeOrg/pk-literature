import { defineOperationApp } from '@directus/extensions-sdk';

export default defineOperationApp({
	id: 'promote-staging-book',
	name: 'Promote Staging Book',
	icon: 'move_up',
	description:
		'Promote an approved staging.staging_books row into catalog.works/catalog.books - creates a new draft-status Work+Book if unmatched, or merges staging fields into the matched existing row (staging value wins per-field when non-null). Idempotent: no-ops if the row is already promoted.',
	overview: ({ stagingBookId }) => [{ label: 'Staging Book', text: stagingBookId }],
	options: [
		{
			field: 'stagingBookId',
			name: 'Staging Book ID',
			type: 'string',
			meta: {
				width: 'full',
				interface: 'input',
				note: 'The staging_books row to promote - wire this to the triggering item\'s key. For an Event Hook (Action) trigger on staging_books filtered to status changing to "approved", that\'s usually {{$trigger.keys[0]}} (batch update) or {{$trigger.key}} (single-item update), depending on which the Flow actually fires on - check $trigger\'s available fields in the Flow\'s own data preview before wiring this.',
				options: { placeholder: '{{$trigger.keys[0]}}' },
			},
		},
	],
});
