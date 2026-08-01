import { defineDisplay } from '@directus/extensions-sdk';
import { defineComponent, h } from 'vue';

// Plain render function, not a .vue SFC — this repo's other extensions
// are all plain TypeScript (no Vue-loader/SFC build step anywhere yet),
// and a display this simple doesn't need one. defineDisplay's own
// `component` option accepts any Vue component, render-function-based
// ones included.
const ImageUrlThumbnail = defineComponent({
	props: {
		value: { type: String, default: null },
		// Directus passes every configured `options` field (see below) as
		// its own prop, keyed by that option's `field` name.
		urlPrefix: { type: String, default: null },
	},
	setup(props) {
		return () => {
			if (!props.value) {
				return h('span', { style: { opacity: '0.5' } }, '—');
			}
			return h('img', {
				src: `${props.urlPrefix ?? ''}${props.value}`,
				alt: props.value,
				style: {
					maxHeight: '40px',
					maxWidth: '60px',
					objectFit: 'cover',
					borderRadius: '4px',
					verticalAlign: 'middle',
				},
			});
		};
	},
});

export default defineDisplay({
	id: 'image-url',
	name: 'Image URL Thumbnail',
	icon: 'image',
	description:
		"Renders a text field's value as an image thumbnail. Leave URL Prefix blank for a field that already stores a full URL (e.g. staging_books.cover_source_url); set it to the CDN base for a field that stores a bare key instead (e.g. catalog.media_assets.s3_key needs https://cdn.<domain>/ prepended).",
	component: ImageUrlThumbnail,
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
	// Not just 'string' - confirmed live that all three target fields
	// (staging_books.cover_source_url, staging_media.source_url,
	// catalog.media_assets.s3_key) are Postgres `text` columns, which
	// Directus's schema introspection maps to its own 'text' type, not
	// 'string' ('string' is Directus's type for varchar/character
	// varying specifically). A 'string'-only types array meant this
	// display was correctly loaded and enabled but never appeared as a
	// selectable option in any of those fields' Display dropdown at
	// all - not a deployment/loading problem, just this filter being
	// too narrow.
	types: ['string', 'text'],
});
