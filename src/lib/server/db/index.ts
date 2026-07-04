import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

const connectionString = env.DATABASE_URL;

/**
 * Resolve the embedded-PGlite data directory for the `lite` profile, or null to
 * use the normal postgres-js driver. Selected when `DATABASE_URL=pglite://…`
 * (path after the scheme; `pglite://memory` = ephemeral) or when
 * `APP_PROFILE=lite` with no DATABASE_URL (defaults to `./.pglite-data`).
 */
function resolvePgliteDataDir(): { dataDir: string | undefined } | null {
	if (building) return null;
	if (connectionString?.startsWith('pglite://')) {
		const spec = connectionString.slice('pglite://'.length);
		const ephemeral = spec === '' || spec === 'memory' || spec === 'memory://';
		return { dataDir: ephemeral ? undefined : spec };
	}
	if ((env.APP_PROFILE ?? '').toLowerCase() === 'lite' && !connectionString) {
		return { dataDir: './.pglite-data' };
	}
	return null;
}

let db: ReturnType<typeof drizzle>;
let sql: ReturnType<typeof postgres>;

const pglite = resolvePgliteDataDir();
if (pglite) {
	// Dynamic import keeps @electric-sql/pglite (~15MB WASM) out of the prod
	// server bundle — it is only ever loaded on the lite path.
	const { createPgliteDb } = await import('./pglite-compat');
	const pair = createPgliteDb(pglite.dataDir);
	db = pair.db;
	sql = pair.sql;
} else {
	if (!connectionString && !building) {
		console.warn('[DB] DATABASE_URL not set — database queries will fail');
	}
	const client = connectionString
		? postgres(connectionString, { max: 10 })
		: (null as unknown as ReturnType<typeof postgres>);
	sql = client;
	db = client ? drizzle(client) : (null as unknown as ReturnType<typeof drizzle>);
}

export { db, sql };
