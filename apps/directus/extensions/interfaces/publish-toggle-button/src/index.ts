import { defineInterface, useApi } from '@directus/extensions-sdk';
import { defineComponent, h, ref, watch } from 'vue';

// For catalog.books.status - unlike approve-button (a one-way ratchet
// toward a terminal state), Publish/Unpublish is a genuine two-way
// toggle: the same button PATCHes status to 'published' when not
// currently published, or back to 'draft' when it is.
//
// Deliberately does NOT pre-check or auto-satisfy
// catalog.sql's enforce_book_work_status trigger (a Book can only
// become 'published' if its Work is already 'approved'/'published') -
// per product decision, a Publish click on a Book whose Work isn't
// approved yet should fail loudly with the database's own rejection
// message, not silently approve the Work on the Book's behalf.
// api.patch's rejection (a 400/500 carrying the trigger's RAISE
// EXCEPTION text) is surfaced directly via errorMessage below.
//
// Unpublish only ever writes the Book's own status back to 'draft' -
// deliberately never touches the parent Work's status, matching
// catalog.sql's own stated philosophy that Work status "never
// auto-reverts... that stays an explicit editor action" (the same
// trigger only validates transitions *into* 'published', not out of
// it, so this direction needs no special handling).
//
// See approve-button's own header comment for why this makes its own
// PATCH call instead of emitting `input` (the write must happen
// immediately, not deferred to the page's Save button, and emitting
// `input` afterward would falsely flag the form as having unsaved
// local changes).
const PublishToggleButton = defineComponent({
	props: {
		value: { type: String, default: null },
		primaryKey: { type: [String, Number], default: null },
		collection: { type: String, default: null },
	},
	setup(props) {
		const api = useApi();
		const currentStatus = ref(props.value);
		const submitting = ref(false);
		const errorMessage = ref<string | null>(null);

		watch(
			() => props.value,
			(next) => {
				currentStatus.value = next;
			},
		);

		async function toggle() {
			if (!props.primaryKey || !props.collection) {
				errorMessage.value = 'Missing primaryKey/collection - cannot save (see publish-toggle-button interface comment).';
				return;
			}

			const isPublished = currentStatus.value === 'published';
			const nextStatus = isPublished ? 'draft' : 'published';

			submitting.value = true;
			errorMessage.value = null;
			try {
				await api.patch(`/items/${props.collection}/${props.primaryKey}`, { status: nextStatus });
				currentStatus.value = nextStatus;
			} catch (err) {
				// Deliberately surfaced verbatim, not swallowed/generalized -
				// this is very likely catalog.sql's enforce_book_work_status
				// trigger rejecting a publish because the Work isn't approved
				// yet, and the editor needs that exact reason, not a generic
				// "something went wrong".
				errorMessage.value = err instanceof Error ? err.message : 'Publish/Unpublish failed - see console for details.';
				console.error('publish-toggle-button: PATCH failed', err);
			} finally {
				submitting.value = false;
			}
		}

		return () => {
			const isPublished = currentStatus.value === 'published';
			const label = submitting.value ? (isPublished ? 'Unpublishing…' : 'Publishing…') : isPublished ? 'Unpublish' : 'Publish';

			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' } }, [
				h(
					'button',
					{
						type: 'button',
						disabled: submitting.value,
						onClick: toggle,
						style: {
							padding: '8px 20px',
							borderRadius: '4px',
							border: 'none',
							fontWeight: '600',
							cursor: submitting.value ? 'default' : 'pointer',
							backgroundColor: isPublished ? 'var(--theme--foreground-subdued, #818992)' : 'var(--theme--primary, #6644ff)',
							color: '#fff',
							opacity: submitting.value ? 0.6 : 1,
						},
					},
					label,
				),
				errorMessage.value ? h('span', { style: { color: 'var(--theme--danger, #e35169)', fontSize: '13px' } }, errorMessage.value) : null,
			]);
		};
	},
});

export default defineInterface({
	id: 'publish-toggle-button',
	name: 'Publish Toggle Button',
	icon: 'publish',
	description:
		"Publish/Unpublish toggle for catalog.books.status. Shows 'Publish' for any not-published status (PATCHes status to 'published' on click - fails loudly if the Book's Work isn't approved yet); shows 'Unpublish' once published (PATCHes back to 'draft', never touching the parent Work's status).",
	component: PublishToggleButton,
	types: ['string', 'text'],
	options: null,
});
