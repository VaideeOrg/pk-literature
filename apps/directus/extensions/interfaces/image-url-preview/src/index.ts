import { defineInterface } from '@directus/extensions-sdk';
import { defineComponent, h } from 'vue';

// Companion to displays/image-url: a Display only ever renders inside
// Table/list cells and related-value chips - the record Detail/Edit
// page renders a field via its *Interface* instead, an entirely
// separate Directus concept, so getting a thumbnail into Table view
// (PR #109/#110/#112) never touched the Detail page at all. Same
// plain-render-function approach as that sibling extension (no
// Vue-loader/SFC step, matching every extension in this repo).
const ImageUrlPreview = defineComponent({
	props: {
		value: { type: String, default: null },
		// Directus passes every configured `options` field as its own
		// prop, keyed by that option's `field` name - same convention as
		// the sibling image-url display.
		urlPrefix: { type: String, default: null },
	},
	setup(props) {
		return () =>
			h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, [
				props.value
					? h('img', {
							src: `${props.urlPrefix ?? ''}${props.value}`,
							alt: props.value,
							style: {
								maxWidth: '240px',
								maxHeight: '240px',
								objectFit: 'contain',
								borderRadius: '6px',
								border: '1px solid var(--theme--border-color-subdued)',
							},
						})
					: h('span', { style: { opacity: '0.5' } }, 'No cover yet'),
				// Read-only, not an editable text input: every field this is
				// wired onto (bootstrap.ts's ensureImageThumbnailDisplays) is
				// system-written by the crawler/promotion pipeline, never
				// hand-typed by an editor - shown only so the raw value is
				// still visible for debugging a broken image, rather than
				// hidden entirely.
				h('input', {
					type: 'text',
					readonly: true,
					value: props.value ?? '',
					style: {
						font: 'inherit',
						fontSize: '13px',
						color: 'var(--theme--foreground-subdued)',
						border: 'none',
						background: 'transparent',
						padding: '0',
						width: '100%',
					},
				}),
			]);
	},
});

export default defineInterface({
	id: 'image-url-preview',
	name: 'Image URL Preview',
	icon: 'image',
	description:
		"Shows a text field's value as an image preview on the record's Detail/Edit page, read-only. Leave URL Prefix blank for a field that already stores a full URL; set it to the CDN base for a field storing a bare S3 key instead (e.g. cover_s3_key, media_assets.s3_key).",
	component: ImageUrlPreview,
	types: ['string', 'text'],
	options: [
		{
			field: 'urlPrefix',
			name: 'URL Prefix',
			type: 'string',
			meta: {
				interface: 'input',
				width: 'full',
				note: 'Prepended to the field value to build the <img> src.',
			},
		},
	],
});
