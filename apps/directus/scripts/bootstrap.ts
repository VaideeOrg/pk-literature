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

	console.log('Directus bootstrap complete.');
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
	process.exitCode = 1;
});
