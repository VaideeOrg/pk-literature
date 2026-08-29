import { defineInterface, useApi } from '@directus/extensions-sdk';
import { defineComponent, h, ref, watch } from 'vue';

// Replaces the default Select Dropdown on staging_books.status with a
// single decisive action, matching the actual editorial workflow
// (SPEC-03: review imported metadata, then decide) rather than
// exposing every raw enum value (pending_validation/needs_review/
// rejected/approved/promoted) as an equally-weighted dropdown choice -
// 'promoted' in particular should never be hand-set (it's
// promote-staging-book's own success marker, migration
// 20260101000023 renamed from 'merged'), and this button never offers
// it as an option at all.
//
// Deliberately makes its own PATCH /items/:collection/:id call rather
// than emitting an `input` value for the surrounding form to save:
// ensurePromotionFlow (bootstrap.ts) is an event-triggered Flow fired
// by items.update, so the write has to actually happen immediately on
// click, not deferred until the editor separately presses Directus's
// own page-level Save button. Deliberately does NOT emit `input`
// after that PATCH either - doing so would flag the form as having
// unsaved local changes (Directus's own dirty-tracking compares the
// original loaded value against the current v-model value), even
// though the value is already fully persisted server-side; the button
// tracks its own post-click state in a local ref instead, entirely
// decoupled from the form's save/dirty state.
//
// primaryKey/collection: standard props Directus's Form component
// passes to every field interface (alongside `value`) - NOT verified
// against a live Directus instance in this sandbox (no way to run the
// actual admin app here, unlike the SQL fixes elsewhere in this
// session, which were verified against a real local Postgres). If
// either arrives undefined, this fails loudly with a visible error
// rather than silently no-op'ing, so a live check after deploy will
// immediately reveal it if this assumption is wrong.
const ApproveButton = defineComponent({
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
			const isDecided = currentStatus.value === 'approved' || currentStatus.value === 'promoted';

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
		"Single-action Approve button for staging_books.status, replacing the raw enum dropdown. Shows 'Approve' for any not-yet-decided status; PATCHes status to 'approved' immediately on click (triggering the promotion Flow), then shows a disabled 'Approved' label for both 'approved' and 'promoted'.",
	component: ApproveButton,
	types: ['string', 'text'],
	options: null,
});
