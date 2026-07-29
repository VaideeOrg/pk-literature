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
	readItems,
	createItem,
	readPermissions,
	createPermission,
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

const ALL_COLLECTIONS = [...CATALOG_COLLECTIONS, ...STAGING_COLLECTIONS];

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

	// directus_access has no dedicated SDK composable — managed as a
	// plain system collection via the generic item operations, same as
	// any other Directus system table (documented pattern for
	// composables the SDK hasn't wrapped yet).
	const existingAccess = await client.request(
		readItems('directus_access', { filter: { role: { _eq: roleId }, policy: { _eq: policyId } } }),
	);
	if (existingAccess.length === 0) {
		await client.request(createItem('directus_access', { role: roleId, policy: policyId }));
		console.log(`role ${name}: attached to its policy`);
	}
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
