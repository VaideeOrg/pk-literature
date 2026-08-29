/**
 * Config-as-code bootstrap for the Editorial Workbench (SPEC-03).
 *
 * NOT independently verified against a live Directus instance — see
 * ../README.md's "Known issue" section (Directus 11.17.4 and 10.13.4
 * have both crashed during first-boot bootstrap against real RDS
 * Postgres; 12.1.1 is the current attempt). Written against the documented
 * @directus/sdk v17 API surface and typechecked against its real type
 * definitions (no live server needed for that — `pnpm --filter directus
 * run typecheck` passes), but the request/response shapes below have
 * not been round-tripped against a running Directus.
 *
 * Idempotent by design: every step reads current state first and only
 * creates what's missing, so this is safe to re-run (CI or manually)
 * after any partial failure.
 *
 * Run with DIRECTUS_URL set, plus either DIRECTUS_TOKEN (a static access
 * token from an existing admin's user profile - preferred, see
 * ../README.md) or DIRECTUS_ADMIN_EMAIL + DIRECTUS_ADMIN_PASSWORD.
 *
 * DIRECTUS_TOKEN is preferred over email/password login: this repo hit
 * a real, live case where ADMIN_EMAIL/ADMIN_PASSWORD (the env vars
 * Directus's own container bootstrap uses) ended up not matching any
 * working admin account after repeated ECS task restarts during an
 * earlier health-check misconfiguration - each restart re-ran
 * Directus's own bootstrap, and at least one attempt appears to have
 * created a second "Administrator" role/user pairing distinct from the
 * one actually logged into in the browser. A static token sidesteps
 * all of that ambiguity: it's tied to the specific, already-verified-
 * working admin account, not to whichever credentials happen to match
 * at the time this script runs.
 */

import {
	createDirectus,
	rest,
	authentication,
	staticToken,
	readCollections,
	createCollection,
	readRoles,
	createRole,
	readPolicies,
	createPolicy,
	customEndpoint,
	readPermissions,
	createPermission,
	readFlows,
	createFlow,
	updateFlow,
	createOperation,
	updateOperation,
	readField,
	readFieldsByCollection,
	updateField,
	createField,
	readCollection,
	updateCollection,
	readPresets,
	createPreset,
} from '@directus/sdk';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required env var: ${name}`);
	}
	return value;
}

const DIRECTUS_URL = requireEnv('DIRECTUS_URL');
const TOKEN = process.env.DIRECTUS_TOKEN;
const ADMIN_EMAIL = process.env.DIRECTUS_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.DIRECTUS_ADMIN_PASSWORD;

// Same fallback convention as apps/api-catalog|api-feed's own
// media-url.ts (CDN_BASE_URL) - only used to prefix the image-url
// display's src for fields storing a bare S3 key rather than a full
// URL (see ensureImageThumbnailDisplays below).
const CDN_BASE_URL = process.env.CDN_BASE_URL ?? 'https://cdn.pk-literature.example';

if (!TOKEN && !(ADMIN_EMAIL && ADMIN_PASSWORD)) {
	throw new Error('Set DIRECTUS_TOKEN, or both DIRECTUS_ADMIN_EMAIL and DIRECTUS_ADMIN_PASSWORD.');
}

function buildTokenClient(token: string) {
	// authentication/staticToken registered BEFORE rest() - the
	// documented @directus/sdk composable order (auth composables
	// extend the client with token storage that rest() then reads from
	// to attach the Authorization header). This alone was NOT the
	// actual cause of a 403-despite-valid-token incident hit live in
	// this repo - that turned out to be an IP-allowlist gap on the
	// account's policies (see migration 20260101000018) - but this is
	// still the correct order per the SDK's own usage pattern, worth
	// keeping regardless.
	return createDirectus(DIRECTUS_URL).with(staticToken(token)).with(rest());
}

function buildLoginClient() {
	// 'json' mode, not the default 'cookie' mode: the SDK's cookie mode
	// relies on the environment's automatic cookie jar (a browser's),
	// which a plain Node script doesn't have - login() would succeed
	// and set a cookie this process immediately discards, then every
	// subsequent authenticated request goes out with no token attached
	// at all, failing 403 as if anonymous. 'json' keeps the access
	// token in memory and attaches it as a Bearer header instead.
	//
	// authentication() registered BEFORE rest() - see
	// buildTokenClient's comment for why (correct SDK usage, not
	// itself the fix for the IP-allowlist incident below).
	return createDirectus(DIRECTUS_URL).with(authentication('json')).with(rest());
}

function buildClient() {
	return TOKEN ? buildTokenClient(TOKEN) : buildLoginClient();
}

type Client = ReturnType<typeof buildClient>;

// plan/contracts/directus/collections.md — top-level collections only.
// The M:N junction tables (work_authors, book_contributors, work_themes,
// work_genres, work_literary_movements, book_collections) become usable
// as M2M alias relationship fields once both sides are tracked and
// Directus infers the FK-backed relations; wiring the alias fields
// explicitly is left as a follow-up (see ../README.md) rather than
// hand-written here untested.
const CATALOG_COLLECTIONS = [
	'works',
	'books',
	'authors',
	'publishers',
	'themes',
	'genres',
	'literary_movements',
	'collections',
	'media_assets',
	'inventory',
];

const STAGING_COLLECTIONS = [
	'import_runs',
	'staging_books',
	'staging_inventory',
	'staging_media',
	'staging_validation',
	'staging_relationships',
];

// discovery.banners only — NOT the rest of api-feed's discovery schema
// (interest_profiles/interest_events/feed_shelves), which Directus has
// no grant on and no editorial reason to touch. See
// apps/api-feed/migrations/20260201000006_banners.sql and
// terraform/environments/prod/directus.tf's DB_SEARCH_PATH comment.
const DISCOVERY_COLLECTIONS = ['banners'];

const ALL_COLLECTIONS = [...CATALOG_COLLECTIONS, ...STAGING_COLLECTIONS, ...DISCOVERY_COLLECTIONS];

// Curated Detail-page field orders for ensureReviewFieldOrder - what
// an editor actually reviews first, everything else (ids, relations,
// audit timestamps) falls below the "Technical Details" divider.
const STAGING_BOOKS_REVIEW_ORDER = [
	'cover_s3_key',
	'status',
	'title',
	'subtitle',
	'author_names',
	'publisher_name',
	'description',
	'language',
	'isbn13',
	'price',
	'currency',
	'stock',
	'category',
	'publication_date',
	'edition_label',
	'page_count',
];

// works has no cover_asset_id of its own (only catalog.books does -
// a Work is the abstract literary work, not itself purchasable/
// coverable; see catalog.sql's own header comment on catalog.books).
const WORKS_REVIEW_ORDER = [
	'status',
	'canonical_title',
	'canonical_title_translit',
	'original_language',
	'work_type',
	'first_publication_year',
	'summary',
];

const BOOKS_REVIEW_ORDER = [
	'cover_s3_key',
	'status',
	'title',
	'subtitle',
	'language',
	'edition_label',
	'edition_number',
	'format',
	'page_count',
	'publication_date',
	'isbn13',
];

async function main() {
	let client: Client;
	if (TOKEN) {
		client = buildTokenClient(TOKEN);
	} else {
		const loginClient = buildLoginClient();
		await loginClient.login(ADMIN_EMAIL as string, ADMIN_PASSWORD as string);
		client = loginClient;
	}

	await ensureCollectionsTracked(client);
	const catalogEditorPolicyId = await ensureCatalogEditorPolicy(client);
	const seniorEditorPolicyId = await ensureSeniorEditorPolicy(client);
	await ensureRoleWithPolicy(client, 'Catalog Editor', catalogEditorPolicyId);
	await ensureRoleWithPolicy(client, 'Senior Editor', seniorEditorPolicyId);
	await ensurePromotionFlow(client);
	await ensureInventoryDecrementFlow(client);
	await ensureImageThumbnailDisplays(client);
	await ensureApproveButtonInterface(client, 'staging_books', 'approved,promoted');
	await ensureReviewFieldOrder(client, 'staging_books', STAGING_BOOKS_REVIEW_ORDER);
	await ensureImportRunRelation(client);
	await ensureBulkApproveFlow(client);
	await ensureApproveButtonInterface(client, 'works', 'approved,published');
	await ensureReviewFieldOrder(client, 'works', WORKS_REVIEW_ORDER);
	await ensurePublishToggleInterface(client);
	await ensureReviewFieldOrder(client, 'books', BOOKS_REVIEW_ORDER);
	await ensurePublishToggleBulkFlows(client);

	console.log('Directus bootstrap complete.');
	// Explicit exit, not a natural fall-through: @directus/sdk's rest()
	// composable keeps its underlying fetch/HTTP client's connection(s)
	// open (keep-alive), which keeps Node's event loop alive too - every
	// single live GitHub Actions run of this script (see workflow run
	// history for directus-bootstrap.yml) has printed this exact line and
	// then just hung until someone manually cancelled the run, well after
	// all real work was done. ts-node has no equivalent of e.g. Jest's
	// --forceExit for this.
	process.exit(0);
}

/**
 * Wires the image-url display AND its companion image-url-preview
 * interface onto every field that holds a cover image reference
 * actually resolvable to a real, servable file — an S3 key served
 * through our own CDN — so editors can see a book's cover without
 * leaving Directus, on both the Table/list view (Display) and the
 * record's own Detail/Edit page (Interface - a Display never renders
 * there, it's a wholly separate Directus extension type). Deliberately
 * NOT wired onto staging_books.cover_source_url or
 * staging_media.source_url: both hold the raw externally-crawled
 * publisher URL, and Directus's CSP
 * (terraform/environments/prod/directus.tf's
 * CONTENT_SECURITY_POLICY_DIRECTIVES__IMG_SRC) only allows img-src
 * from our own CDN origin, not arbitrary external domains — confirmed
 * live that a CSP-blocked <img> src never even shows up as a request
 * in the browser's Network tab, let alone a 403/404 from the
 * publisher's own site. apps/publisher-crawler's run-import.ts already
 * downloads the cover to S3 (staging.staging_media.s3_key) whenever
 * coverSourceUrl is set, so the actual servable copy always exists by
 * the time a staging book does — render that instead of opening CSP up
 * to every publisher's domain.
 *
 * staging_books.cover_s3_key (migration
 * 20260101000022_staging_books_cover_s3_key.sql) is a denormalized
 * write-through of the same value onto staging_books itself -
 * Directus's Table/Card layouts can't reach into a *related*
 * collection's field to render a thumbnail, so the only way to show a
 * cover directly on the staging_books browse table (the actual
 * editorial workflow PR #109 was built for) is a real column on that
 * row, kept in sync by StagingBooksService.submit() every time a cover
 * is stored.
 *
 * readonly is set on the staging-side fields and books.cover_s3_key
 * (never media_assets - a promoted catalog record editors may
 * legitimately need to hand-fix) since all three are exclusively
 * system-written (the crawler/storeCover pipeline, or
 * promote-staging-book's promoteMedia() for books.cover_s3_key -
 * migration 20260101000024) - never something an editor is expected
 * to hand-type, and the preview interface itself has no editable
 * control anyway.
 */
async function ensureImageThumbnailDisplays(client: Client) {
	const targets: { collection: string; field: string; urlPrefix: string; readonly?: boolean }[] = [
		{ collection: 'staging_books', field: 'cover_s3_key', urlPrefix: `${CDN_BASE_URL}/`, readonly: true },
		{ collection: 'staging_media', field: 's3_key', urlPrefix: `${CDN_BASE_URL}/`, readonly: true },
		{ collection: 'media_assets', field: 's3_key', urlPrefix: `${CDN_BASE_URL}/` },
		{ collection: 'books', field: 'cover_s3_key', urlPrefix: `${CDN_BASE_URL}/`, readonly: true },
	];

	for (const target of targets) {
		const current = await client.request(readField(target.collection, target.field));
		const alreadyCorrect =
			current.meta?.display === 'image-url' &&
			current.meta?.interface === 'image-url-preview' &&
			(!target.readonly || current.meta?.readonly === true);
		if (alreadyCorrect) {
			console.log(`display/interface ${target.collection}.${target.field}: already set`);
			continue;
		}

		await client.request(
			updateField(target.collection, target.field, {
				meta: {
					interface: 'image-url-preview',
					// The interface's own options live on `options`, not a
					// separate "interface_options" key - display_options is
					// the display's equivalent, but the SDK's DirectusField
					// type has no such field for interfaces (confirmed by
					// tsc: only `options` exists alongside `display_options`).
					options: { urlPrefix: target.urlPrefix },
					display: 'image-url',
					display_options: { urlPrefix: target.urlPrefix },
					...(target.readonly ? { readonly: true } : {}),
				},
			}),
		);
		console.log(`display/interface ${target.collection}.${target.field}: set to image-url/image-url-preview`);
	}

	// staging_books.cover_source_url and staging_media.source_url were
	// wired to this same display in PR #109/#110, before the S3-backed
	// alternative above existed. Revert them back to no display rather
	// than leave them silently unmanaged and permanently unrenderable
	// now that CSP isn't opening up for external domains.
	const staleTargets = [
		{ collection: 'staging_books', field: 'cover_source_url' },
		{ collection: 'staging_media', field: 'source_url' },
	];
	for (const target of staleTargets) {
		const current = await client.request(readField(target.collection, target.field));
		if (current.meta?.display !== 'image-url') {
			console.log(`display ${target.collection}.${target.field}: already not image-url`);
			continue;
		}

		await client.request(
			updateField(target.collection, target.field, {
				meta: { display: null, display_options: null },
			}),
		);
		console.log(`display ${target.collection}.${target.field}: reverted from image-url to none`);
	}
}

/**
 * Replaces the default Select Dropdown on a status field with a
 * single Approve action button (extensions/interfaces/approve-button)
 * - editors take one decision (approve), not pick between several
 * equally-weighted raw enum values, some of which (staging_books'
 * 'promoted', works'/books' 'published' via the enforce_book_work_
 * status cascade) should never be hand-set via a plain dropdown at
 * all. finalStatuses is that extension's own configurable "already
 * decided" list - see its header comment for why works.status needs
 * a different one than staging_books.status.
 */
async function ensureApproveButtonInterface(client: Client, collection: string, finalStatuses: string) {
	const field = await client.request(readField(collection, 'status'));
	if (field.meta?.interface === 'approve-button' && field.meta?.options?.finalStatuses === finalStatuses) {
		console.log(`interface ${collection}.status: already approve-button (${finalStatuses})`);
		return;
	}

	await client.request(
		updateField(collection, 'status', {
			meta: {
				interface: 'approve-button',
				options: { finalStatuses },
				display: null,
				display_options: null,
			},
		}),
	);
	console.log(`interface ${collection}.status: set to approve-button (${finalStatuses})`);
}

/**
 * Reorders a collection's Detail-page fields so what an editor
 * actually reviews sits at the top, with system/technical fields
 * (IDs, relations, audit timestamps) pushed below a labeled divider.
 * Directus renders a plain Detail form purely by each field's own
 * meta.sort, ascending - there's no separate "layout" concept to lean
 * on here, so this is just a full sort-order rewrite every run
 * (cheap, and simpler than tracking partial drift field-by-field).
 * Shared by staging_books, works, and books - each just supplies its
 * own curated REVIEW_ORDER.
 */
async function ensureReviewFieldOrder(client: Client, collection: string, reviewOrder: string[]) {
	const DIVIDER_FIELD = 'technical_details_divider';

	let fields = await client.request(readFieldsByCollection(collection));

	if (!fields.some((f) => f.field === DIVIDER_FIELD)) {
		await client.request(
			createField(collection, {
				field: DIVIDER_FIELD,
				type: 'alias',
				meta: {
					special: ['alias', 'no-data'],
					interface: 'presentation-divider',
					options: { title: 'Technical Details', icon: 'settings' },
					width: 'full',
				},
			}),
		);
		console.log(`field ${collection}.${DIVIDER_FIELD}: created`);
		fields = await client.request(readFieldsByCollection(collection));
	}

	const desiredOrder = [
		...reviewOrder.filter((name) => fields.some((f) => f.field === name)),
		DIVIDER_FIELD,
		...fields.map((f) => f.field).filter((name) => !reviewOrder.includes(name) && name !== DIVIDER_FIELD),
	];

	const currentOrder = [...fields].sort((a, b) => (a.meta?.sort ?? 0) - (b.meta?.sort ?? 0)).map((f) => f.field);

	if (JSON.stringify(currentOrder) === JSON.stringify(desiredOrder)) {
		console.log(`${collection} field order: already correct`);
		return;
	}

	for (const [index, name] of desiredOrder.entries()) {
		await client.request(updateField(collection, name, { meta: { sort: index + 1 } }));
	}
	console.log(`${collection} field order: review fields on top, technical fields below a divider`);
}

/**
 * Wires staging_books.import_run_id as a real Many-to-One relation to
 * import_runs. Postgres already has this FK (migration
 * 20260101000004_staging_init.sql) - Directus's own schema
 * introspection auto-detects the relation once both collections are
 * tracked, this just gives the field a real picker interface instead
 * of showing the bare uuid as plain text, and gives import_runs a
 * human-readable display template + a newest-first default sort, so
 * both the relation picker and import_runs' own Browse view read as
 * "2026-08-29T02:34:06 — scheduled" instead of a raw UUID column.
 *
 * NOT verified live whether the default preset below also governs the
 * *Filter panel's* relational picker sort specifically (staging_books
 * -> filter by Import Run), as opposed to just import_runs' own
 * Browse table - both draw on the same collection/sort concept but
 * this repo has no way to run the real admin app to confirm which
 * paths actually consult it. Worth checking after deploy; the
 * picker's own search-by-typing still works regardless of default
 * order if it isn't picked up.
 */
async function ensureImportRunRelation(client: Client) {
	const DISPLAY_TEMPLATE = '{{started_at}} — {{trigger}}';

	const field = await client.request(readField('staging_books', 'import_run_id'));
	if (field.meta?.interface !== 'select-dropdown-m2o') {
		await client.request(
			updateField('staging_books', 'import_run_id', {
				meta: {
					interface: 'select-dropdown-m2o',
					special: ['m2o'],
					display: 'related-values',
					display_options: { template: DISPLAY_TEMPLATE },
				},
			}),
		);
		console.log('field staging_books.import_run_id: wired as many-to-one -> import_runs');
	} else {
		console.log('field staging_books.import_run_id: already many-to-one');
	}

	const collection = await client.request(readCollection('import_runs'));
	if (collection.meta?.display_template !== DISPLAY_TEMPLATE || collection.meta?.sort_field !== 'started_at') {
		await client.request(
			updateCollection('import_runs', {
				meta: { display_template: DISPLAY_TEMPLATE, sort_field: 'started_at' },
			}),
		);
		console.log('collection import_runs: display template + sort field set');
	} else {
		console.log('collection import_runs: display template + sort field already set');
	}

	// A "default" preset - no bookmark/user/role - is Directus's
	// fallback view for anyone without their own saved layout.
	const existingDefaultPreset = await client.request(
		readPresets({
			filter: {
				collection: { _eq: 'import_runs' },
				bookmark: { _null: true },
				user: { _null: true },
				role: { _null: true },
			},
		}),
	);
	if (!existingDefaultPreset[0]) {
		await client.request(
			createPreset({
				collection: 'import_runs',
				layout: 'tabular',
				layout_query: { tabular: { sort: ['-started_at'] } },
			}),
		);
		console.log('preset import_runs: default newest-first sort created');
	} else {
		console.log('preset import_runs: default sort already exists');
	}
}

/**
 * Manual-trigger Flow, surfaced by Directus as a toolbar button in
 * staging_books' Browse view once 1+ rows are selected (reusing the
 * checkbox selection already built into the Table layout) - sets
 * status='approved' on every selected row, the exact same write the
 * Detail-page Approve button makes. Deliberately does NOT duplicate
 * promote-staging-book's own logic: ensurePromotionFlow is an
 * items.update event Flow, so it fires identically regardless of
 * which path caused the write.
 *
 * NOT verified live: the built-in "Update Data" operation's type key
 * (item-update) and options shape below, and the manual trigger's own
 * options shape - Directus's Flow/Operation `options` are untyped
 * (Record<string, any>) in the SDK, or opaque to their app UI
 * implementation, verifiable now that live Directus access exists.
 */
async function ensureBulkApproveFlow(client: Client) {
	const FLOW_NAME = 'Approve Staging Books';
	const existingFlows = await client.request(readFlows({ filter: { name: { _eq: FLOW_NAME } } }));
	if (existingFlows[0]) {
		console.log(`flow ${FLOW_NAME}: already exists`);
		return;
	}

	const flow = await client.request(
		createFlow({
			name: FLOW_NAME,
			icon: 'check_circle',
			description:
				'Sets status=approved on the selected staging_books row(s), triggering Promote Staging Book the same as the Detail-page Approve button.',
			status: 'active',
			trigger: 'manual',
			accountability: 'all',
			options: {
				collections: ['staging_books'],
				location: 'item',
				requireConfirmation: false,
			},
		}),
	);
	console.log(`flow ${FLOW_NAME}: created`);

	const updateStatusOperation = await client.request(
		createOperation({
			name: 'Set status = approved',
			key: 'set_status_approved',
			type: 'item-update',
			position_x: 19,
			position_y: 1,
			flow: flow.id,
			options: {
				collection: 'staging_books',
				payload: { status: 'approved' },
				key: '{{$trigger.body.keys}}',
				emitEvents: true,
			},
		}),
	);

	await client.request(updateFlow(flow.id, { operation: updateStatusOperation.id }));
	console.log(`flow ${FLOW_NAME}: wired (manual trigger -> set_status_approved)`);
}

/**
 * Replaces the default Select Dropdown on catalog.books.status with a
 * Publish/Unpublish toggle (extensions/interfaces/publish-toggle-button)
 * - the actual editorial decision a Book review ends with (SPEC-03:
 * final checks, then publish for sale), not a five-way raw enum
 * choice. See that extension's own header comment for why it doesn't
 * pre-approve the parent Work (catalog.sql's enforce_book_work_status
 * trigger rejects the publish outright if the Work isn't approved yet
 * - by design, surfaced to the editor rather than silently worked
 * around) and why Unpublish only ever touches the Book's own status.
 */
async function ensurePublishToggleInterface(client: Client) {
	const field = await client.request(readField('books', 'status'));
	if (field.meta?.interface === 'publish-toggle-button') {
		console.log('interface books.status: already publish-toggle-button');
		return;
	}

	await client.request(
		updateField('books', 'status', {
			meta: { interface: 'publish-toggle-button', options: null, display: null, display_options: null },
		}),
	);
	console.log('interface books.status: set to publish-toggle-button');
}

/**
 * Two manual-trigger Flows ("Publish Books" / "Unpublish Books"),
 * surfaced by Directus as toolbar buttons in books' Browse view once
 * 1+ rows are selected - same checkbox-selection + toolbar pattern as
 * ensureBulkApproveFlow, but split into two flows rather than one
 * toggle: a bulk action on a *mixed* selection (some published, some
 * not) has to be unambiguous, unlike the single-record toggle button
 * above which always knows its own current state.
 */
async function ensurePublishToggleBulkFlows(client: Client) {
	const DESIRED_LOCATION = 'both';
	const flowsToEnsure = [
		{ name: 'Publish Books', icon: 'publish', status: 'published', key: 'set_status_published' },
		{ name: 'Unpublish Books', icon: 'unpublished', status: 'draft', key: 'set_status_draft' },
	] as const;

	for (const { name, icon, status, key } of flowsToEnsure) {
		const existingFlows = await client.request(readFlows({ filter: { name: { _eq: name } } }));
		if (existingFlows[0]) {
			if (existingFlows[0].options?.location !== DESIRED_LOCATION) {
				await client.request(
					updateFlow(existingFlows[0].id, {
						options: { ...existingFlows[0].options, location: DESIRED_LOCATION },
					}),
				);
				console.log(`flow ${name}: options.location corrected to '${DESIRED_LOCATION}'`);
			} else {
				console.log(`flow ${name}: already exists`);
			}
			continue;
		}

		const flow = await client.request(
			createFlow({
				name,
				icon,
				description: `Sets status=${status} on the selected books row(s), the same write the Detail-page Publish/Unpublish button makes.`,
				status: 'active',
				trigger: 'manual',
				accountability: 'all',
				options: {
					collections: ['books'],
					location: DESIRED_LOCATION,
					requireConfirmation: false,
				},
			}),
		);
		console.log(`flow ${name}: created`);

		const updateStatusOperation = await client.request(
			createOperation({
				name: `Set status = ${status}`,
				key,
				type: 'item-update',
				position_x: 19,
				position_y: 1,
				flow: flow.id,
				options: {
					collection: 'books',
					payload: { status },
					key: '{{$trigger.body.keys}}',
					emitEvents: true,
				},
			}),
		);

		await client.request(updateFlow(flow.id, { operation: updateStatusOperation.id }));
		console.log(`flow ${name}: wired (manual trigger -> ${key})`);
	}
}

async function ensureCollectionsTracked(client: Client) {
	const existing = new Set((await client.request(readCollections())).map((c) => c.collection));

	for (const collection of ALL_COLLECTIONS) {
		if (existing.has(collection)) {
			console.log(`collection ${collection}: already tracked`);
			continue;
		}

		// Table already exists in Postgres (migrations own the DDL).
		// Omitting `schema` skips CollectionsService.createOne()'s
		// CREATE TABLE branch entirely (it's gated on `payload.schema`
		// being present) - Directus 12.1.1 has no separate
		// "introspect an existing table" mode keyed off an empty
		// `fields` array despite what an earlier version of this
		// comment assumed (verified live against the deployed
		// dist/services/collections.js: `fields` isn't even a
		// DirectusCollection SDK type field). `meta` must be present
		// instead - that's what triggers the directus_collections
		// tracking-row insert, the only thing that actually registers
		// the collection.
		await client.request(createCollection({ collection, meta: {} }));
		console.log(`collection ${collection}: tracked`);
	}
}

/**
 * Catalog Editor (SPEC-03): "Create Edit Review. Cannot delete
 * published books." The spec called for enforcing that via a
 * `validation` rule blocking published/archived status transitions
 * plus a `permissions` filter blocking delete on published rows - but
 * both are Directus "custom permission rules", gated behind the
 * `custom_permission_rules_enabled` license entitlement
 * (services/permissions.js: `!getEntitlementManager().isEntitled(...)
 * && hasCustomRule(data) => ResourceRestrictedError`), confirmed live
 * against prod: `directus_settings.license_key`/`license_token` are
 * both null on this self-hosted instance, so it isn't entitled and
 * every attempt to create such a permission 403s outright.
 *
 * Simplified to full, unrestricted CRUD on every catalog + staging
 * collection, same shape as Senior Editor below - the status-gated
 * restriction isn't enforced at the Directus permission layer for
 * now. If it's needed later without a license, it'd have to be a
 * custom extension (an items.update/items.delete filter hook)
 * enforcing the same rule in application code instead.
 */
async function ensureCatalogEditorPolicy(client: Client): Promise<string> {
	const policyId = await ensurePolicy(client, 'Catalog Editor');

	for (const collection of ALL_COLLECTIONS) {
		for (const action of ['read', 'create', 'update', 'delete'] as const) {
			await ensurePermission(client, policyId, collection, action, {});
		}
	}

	return policyId;
}

/**
 * Senior Editor (SPEC-03): "Publish Archive Merge duplicates" — full,
 * unrestricted CRUD on every catalog + staging collection.
 */
async function ensureSeniorEditorPolicy(client: Client): Promise<string> {
	const policyId = await ensurePolicy(client, 'Senior Editor');

	for (const collection of ALL_COLLECTIONS) {
		for (const action of ['read', 'create', 'update', 'delete'] as const) {
			await ensurePermission(client, policyId, collection, action, {});
		}
	}

	return policyId;
}

async function ensurePolicy(client: Client, name: string): Promise<string> {
	const existing = await client.request(readPolicies({ filter: { name: { _eq: name } } }));
	const first = existing[0];
	if (first) {
		console.log(`policy ${name}: already exists`);
		return first.id as string;
	}

	const created = await client.request(
		createPolicy({
			name,
			icon: 'badge',
			admin_access: false,
			app_access: true,
		}),
	);
	console.log(`policy ${name}: created`);
	return created.id as string;
}

async function ensureRoleWithPolicy(client: Client, name: string, policyId: string) {
	const existingRoles = await client.request(readRoles({ filter: { name: { _eq: name } } }));
	let roleId: string;
	if (existingRoles[0]) {
		roleId = existingRoles[0].id as string;
		console.log(`role ${name}: already exists`);
	} else {
		const created = await client.request(createRole({ name, icon: 'edit' }));
		roleId = created.id as string;
		console.log(`role ${name}: created`);
	}

	// directus_access has no dedicated SDK composable, so this uses
	// customEndpoint() (the SDK's raw-request escape hatch) directly
	// against its own dedicated /access route (controllers/access.js -
	// AccessService, mounted via middleware/use-collection.js), NOT
	// /items/directus_access. Verified live against the deployed
	// controllers/items.js: it unconditionally throws ForbiddenError
	// for ANY system collection routed through the generic
	// /items/:collection path (`isSystemCollection(...) =>
	// ForbiddenError`), independent of admin status entirely - that's
	// deliberate Directus hardening (system tables are only meant to be
	// reached via their own dedicated controllers), not a permissions
	// bug. Every directus_* table has an equivalent dedicated
	// controller/route for exactly this reason.
	const existingAccess = await client.request(
		customEndpoint<{ id: number }[]>({
			path: '/access',
			method: 'GET',
			params: { filter: { role: { _eq: roleId }, policy: { _eq: policyId } } },
		}),
	);
	if (existingAccess.length === 0) {
		await client.request(
			customEndpoint({
				path: '/access',
				method: 'POST',
				body: JSON.stringify({ role: roleId, policy: policyId }),
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		console.log(`role ${name}: attached to its policy`);
	}
}

/**
 * Wires the promote-staging-book custom operation
 * (extensions/operations/promote-staging-book) to actually fire: an
 * event-hook Flow, triggered after any update to staging_books,
 * gated by a condition operation checking status == 'approved' so it
 * only proceeds down the trigger-then-condition-then-promote chain on
 * the specific transition that matters (any other field edit, or a
 * status change to something other than 'approved', reaches the
 * condition and stops there via its unset `reject` edge).
 *
 * Condition filter path confirmed live: a real trigger firing (
 * webhook log showed `{ event, payload: { status: "approved" },
 * keys, collection }`) plus reading operations/condition/index.js
 * inside the running container together confirmed `data` for this
 * first operation is that whole event object, not payload flattened
 * to top level - see the filter's own inline comment below for the
 * full reasoning. This function's remaining unverified piece: whether
 * `{{$trigger.keys[0]}}` correctly resolves for the second operation
 * (promote_to_catalog's stagingBookId option) - not yet confirmed the
 * flow gets that far, only that the condition operation itself now
 * evaluates correctly.
 */
async function ensurePromotionFlow(client: Client) {
	const FLOW_NAME = 'Promote Staging Book';
	const existingFlows = await client.request(readFlows({ filter: { name: { _eq: FLOW_NAME } } }));
	if (existingFlows[0]) {
		console.log(`flow ${FLOW_NAME}: already exists`);
		return;
	}

	const flow = await client.request(
		createFlow({
			name: FLOW_NAME,
			icon: 'move_up',
			description: "Promotes an approved staging_books row into catalog.works/catalog.books. See extensions/operations/promote-staging-book.",
			status: 'active',
			trigger: 'event',
			accountability: 'all',
			options: {
				type: 'action',
				scope: ['items.update'],
				collections: ['staging_books'],
			},
		}),
	);
	console.log(`flow ${FLOW_NAME}: created`);

	const conditionOperation = await client.request(
		createOperation({
			name: 'Status is approved?',
			key: 'status_is_approved',
			type: 'condition',
			position_x: 19,
			position_y: 1,
			flow: flow.id,
			// CONFIRMED live against a real trigger firing (verified via a
			// temporary Run Script operation that echoed its `data` argument
			// straight into the run log): the condition operation's `filter`
			// is validated directly against `data` (operations/condition/
			// index.js: `validatePayload(parsedFilter, data, { requireAll:
			// true })`), and for an event-hook trigger `data` is namespaced
			// as `{ $trigger: { event, payload, keys, collection }, $last,
			// $accountability, $env }` - NOT the raw trigger event object
			// directly, and NOT `payload` flattened to the top level either.
			// Two earlier guesses (`{ status: ... }`, then
			// `{ payload: { status: ... } }`) both failed with "Value is
			// required" for exactly this reason - only `$trigger.payload.
			// status` actually exists on `data`.
			options: {
				filter: {
					$trigger: {
						payload: {
							status: { _eq: 'approved' },
						},
					},
				},
			},
		}),
	);

	const promoteOperation = await client.request(
		createOperation({
			name: 'Promote to catalog',
			key: 'promote_to_catalog',
			type: 'promote-staging-book',
			position_x: 39,
			position_y: 1,
			flow: flow.id,
			options: {
				stagingBookId: '{{$trigger.keys[0]}}',
			},
		}),
	);

	await client.request(updateOperation(conditionOperation.id, { resolve: promoteOperation.id }));
	await client.request(updateFlow(flow.id, { operation: conditionOperation.id }));
	console.log(`flow ${FLOW_NAME}: wired (trigger -> status_is_approved -> promote_to_catalog)`);
}

/**
 * Webhook-triggered, not event-triggered like ensurePromotionFlow -
 * this Flow has no staging_books/catalog collection change to react
 * to; it's invoked directly (POST /flows/trigger/<flow-id>) by
 * apps/api-commerce's inventory-sync-consumer Lambda (online orders)
 * and apps/medusa's store-order creation route (walk-in orders) - see
 * packages/contracts/src/events.ts's InventoryDecrementRequestedEvent.
 *
 * UNVERIFIED, more so than ensurePromotionFlow's own webhook-adjacent
 * pieces: this repo has only ever live-confirmed an event-trigger's
 * `data` shape (`{ $trigger: { event, payload, keys, collection },
 * ... }, via the Run Script echo test documented on that function).
 * A webhook trigger's `$trigger` is assumed by direct analogy (and
 * Directus's public docs) to carry `{ body, headers, query, method,
 * ... }` instead of `{ event, payload, keys, collection }` - `{{$trigger.
 * body.items}}`/`{{$trigger.body.secret}}` below are written against
 * that assumption, not independently confirmed live the way the
 * promotion Flow's condition filter eventually was. Treat this the
 * same way: if the deployed Flow errors on first real invocation,
 * checking `$trigger`'s actual shape via a temporary Run Script
 * operation (same technique used to resolve the promotion Flow's
 * filter) is the fix, not further guessing.
 *
 * Created with a fixed id (INVENTORY_DECREMENT_FLOW_ID below), unlike
 * ensurePromotionFlow's flow - that one only needs its own id to wire
 * its own operations together, entirely within this script. This
 * flow's id is also needed by two things this script has no relation
 * to: apps/api-commerce's inventory-sync-handler.ts and apps/medusa's
 * store-order route both call POST /flows/trigger/<flow-id> directly,
 * and their own INVENTORY_DECREMENT_FLOW_ID env var (terraform/
 * environments/prod/api-commerce.tf, medusa.tf) is set at `terraform
 * apply` time - before this bootstrap script has ever run, so there's
 * no "look up the id Directus generated" step available to them. A
 * fixed id sidesteps that ordering problem entirely.
 */
const INVENTORY_DECREMENT_FLOW_ID = '39bac6a4-b6c2-4c82-a14f-0231735c0cc4';

async function ensureInventoryDecrementFlow(client: Client) {
	const FLOW_NAME = 'Decrement Inventory Stock';
	const existingFlows = await client.request(readFlows({ filter: { name: { _eq: FLOW_NAME } } }));
	if (existingFlows[0]) {
		console.log(`flow ${FLOW_NAME}: already exists`);
		return;
	}

	const flow = await client.request(
		createFlow({
			id: INVENTORY_DECREMENT_FLOW_ID,
			name: FLOW_NAME,
			icon: 'remove_shopping_cart',
			description:
				"Decrements catalog.inventory.stock for a list of {bookId, quantity} items. Triggered by a webhook - see extensions/operations/decrement-inventory-stock and packages/contracts/src/events.ts's InventoryDecrementRequestedEvent.",
			status: 'active',
			trigger: 'webhook',
			accountability: 'all',
			options: {
				method: 'POST',
			},
		}),
	);
	console.log(`flow ${FLOW_NAME}: created`);

	const decrementOperation = await client.request(
		createOperation({
			name: 'Decrement stock',
			key: 'decrement_stock',
			type: 'decrement-inventory-stock',
			position_x: 19,
			position_y: 1,
			flow: flow.id,
			options: {
				secret: '{{$trigger.body.secret}}',
				items: '{{$trigger.body.items}}',
			},
		}),
	);

	await client.request(updateFlow(flow.id, { operation: decrementOperation.id }));
	console.log(`flow ${FLOW_NAME}: wired (webhook -> decrement_stock)`);
}

async function ensurePermission(
	client: Client,
	policyId: string,
	collection: string,
	action: 'create' | 'read' | 'update' | 'delete',
	rules: { permissions?: Record<string, unknown>; validation?: Record<string, unknown> },
) {
	const existing = await client.request(
		readPermissions({
			filter: { policy: { _eq: policyId }, collection: { _eq: collection }, action: { _eq: action } },
		}),
	);
	if (existing.length > 0) {
		return;
	}

	await client.request(
		createPermission({
			policy: policyId,
			collection,
			action,
			fields: ['*'],
			permissions: rules.permissions ?? {},
			validation: rules.validation ?? {},
		}),
	);
	console.log(`permission ${policyId}/${collection}/${action}: created`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
