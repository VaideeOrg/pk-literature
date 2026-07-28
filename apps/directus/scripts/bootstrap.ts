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
	return createDirectus(DIRECTUS_URL).with(rest()).with(staticToken(token));
}

function buildLoginClient() {
	// 'json' mode, not the default 'cookie' mode: the SDK's cookie mode
	// relies on the environment's automatic cookie jar (a browser's),
	// which a plain Node script doesn't have - login() would succeed
	// and set a cookie this process immediately discards, then every
	// subsequent authenticated request goes out with no token attached
	// at all, failing 403 as if anonymous. 'json' keeps the access
	// token in memory and attaches it as a Bearer header instead - a
	// real, live-confirmed failure mode, not a hypothetical one.
	return createDirectus(DIRECTUS_URL).with(rest()).with(authentication('json'));
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

// Collections a role gets full CRUD on regardless of status field
// restrictions (everything staging-side — SPEC-03: "Editor Review" of
// staging content isn't status-gated the way production catalog is).
const STATUS_GATED_COLLECTIONS = ['works', 'books', 'collections'];

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

		// Table already exists in Postgres (migrations own the DDL) — an
		// empty `fields` array tells Directus to introspect the existing
		// table rather than create a new one.
		await client.request(createCollection({ collection, fields: [] }));
		console.log(`collection ${collection}: tracked`);
	}
}

/**
 * Catalog Editor (SPEC-03): "Create Edit Review. Cannot delete
 * published books." Modeled as: full read/create/update on catalog +
 * staging collections, but the `status` field on works/books/collections
 * can never be set to published/archived (validation rule), and delete
 * is denied outright on any row currently in `published` status
 * (permissions filter).
 */
async function ensureCatalogEditorPolicy(client: Client): Promise<string> {
	const policyId = await ensurePolicy(client, 'Catalog Editor');

	for (const collection of ALL_COLLECTIONS) {
		await ensurePermission(client, policyId, collection, 'read', {});
		await ensurePermission(client, policyId, collection, 'create', {});

		if (STATUS_GATED_COLLECTIONS.includes(collection)) {
			await ensurePermission(client, policyId, collection, 'update', {
				validation: { status: { _nin: ['published', 'archived'] } },
			});
			await ensurePermission(client, policyId, collection, 'delete', {
				permissions: { status: { _neq: 'published' } },
			});
		} else {
			await ensurePermission(client, policyId, collection, 'update', {});
			await ensurePermission(client, policyId, collection, 'delete', {});
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
