import { defineInterface, useApi } from '@directus/extensions-sdk';
import { defineComponent, h, ref, watch } from 'vue';

// Replaces the default Select Dropdown on a status field with a
// single decisive action, matching the actual editorial workflow
// (review, then decide) rather than exposing every raw enum value as
// an equally-weighted dropdown choice. Originally built for
// staging_books.status (SPEC-03; 'promoted' - migration 20260101000023
// renamed from 'merged' - should never be hand-set, it's
// promote-staging-book's own success marker) and reused on
// works.status: a Work's own "decided" set additionally includes
// 'published', since catalog.sql's enforce_book_work_status trigger
// auto-promotes a Work to 'published' the moment any of its Books
// publishes - without finalStatuses configured per-instance, this
// component would otherwise show a live, clickable "Approve" on an
// already-published Work, and clicking it would regress that Work's
// status from 'published' back down to 'approved'.
//
// Deliberately makes its own PATCH /items/:collection/:id call rather
// than emitting an `input` value for the surrounding form to save:
// the collections this is wired onto (bootstrap.ts) both react to
// items.update via an event-triggered Flow, so the write has to
// actually happen immediately on click, not deferred until the editor
// separately presses Directus's own page-level Save button.
// Deliberately does NOT emit `input` after that PATCH either - doing
// so would flag the form as having unsaved local changes (Directus's
// own dirty-tracking compares the original loaded value against the
// current v-model value), even though the value is already fully
// persisted server-side; the button tracks its own post-click state
// in a local ref instead, entirely decoupled from the form's
// save/dirty state.
//
// primaryKey/collection: standard props Directus's Form component
// passes to every field interface (alongside `value`) - confirmed
// live against a real Directus instance (staging_books' own Approve
// button, #116) after being unverifiable from this sandbox alone (no
// way to run the actual admin app here, unlike the SQL fixes
// elsewhere in this session).
const ApproveButton = defineComponent({
	props: {
		value: { type: String, default: null },
		primaryKey: { type: [String, Number], default: null },
		collection: { type: String, default: null },
		// Comma-separated status values this button treats as "already
		// decided" (disabled, showing "Approved") rather than clickable.
		// Defaults to staging_books' own original behavior.
		finalStatuses: { type: String, default: 'approved,promoted' },
	},
	setup(props) {
		const api = useApi();
		const currentStatus = ref(props.value);
		const submitting = ref(false);
		const errorMessage = ref<string | null>(null);

		// The prop can change out from under the button (e.g. Directus
		// re-fetches the item after a page-level Save triggered by some
		// other field) - stay in sync rather than freezing on whatever
		// value was current at mount.
		watch(
			() => props.value,
			(next) => {
				currentStatus.value = next;
			},
		);

		async function approve() {
			if (!props.primaryKey || !props.collection) {
				errorMessage.value = 'Missing primaryKey/collection - cannot save (see approve-button interface comment).';
				return;
			}

			submitting.value = true;
			errorMessage.value = null;
			try {
				await api.patch(`/items/${props.collection}/${props.primaryKey}`, { status: 'approved' });
				currentStatus.value = 'approved';
			} catch (err) {
				errorMessage.value = err instanceof Error ? err.message : 'Approve failed - see console for details.';
				console.error('approve-button: PATCH failed', err);
			} finally {
				submitting.value = false;
			}
		}

		return () => {
			const finalSet = new Set(props.finalStatuses.split(',').map((s) => s.trim()));
			const isDecided = currentStatus.value !== null && finalSet.has(currentStatus.value);

			return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-start' } }, [
				h(
					'button',
					{
						type: 'button',
						disabled: isDecided || submitting.value,
						onClick: approve,
						style: {
							padding: '8px 20px',
							borderRadius: '4px',
							border: 'none',
							fontWeight: '600',
							cursor: isDecided || submitting.value ? 'default' : 'pointer',
							backgroundColor: isDecided ? 'var(--theme--success, #2ecda7)' : 'var(--theme--primary, #6644ff)',
							color: '#fff',
							opacity: submitting.value ? 0.6 : 1,
						},
					},
					isDecided ? 'Approved' : submitting.value ? 'Approving…' : 'Approve',
				),
				errorMessage.value ? h('span', { style: { color: 'var(--theme--danger, #e35169)', fontSize: '13px' } }, errorMessage.value) : null,
			]);
		};
	},
});

export default defineInterface({
	id: 'approve-button',
	name: 'Approve Button',
	icon: 'check_circle',
	description:
		"Single-action Approve button, replacing a status field's raw enum dropdown. Shows 'Approve' for any not-yet-decided status; PATCHes status to 'approved' immediately on click, then shows a disabled 'Approved' label once the value is in the configured Final Statuses list.",
	component: ApproveButton,
	types: ['string', 'text'],
	options: [
		{
			field: 'finalStatuses',
			name: 'Final Statuses',
			type: 'string',
			meta: {
				interface: 'input',
				width: 'full',
				note: "Comma-separated status values treated as already-decided (button shows disabled 'Approved'). Default: approved,promoted",
			},
			schema: { default_value: 'approved,promoted' },
		},
	],
});
