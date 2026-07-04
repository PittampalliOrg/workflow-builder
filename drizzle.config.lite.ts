import { resolve } from 'node:path';
import type { Config } from 'drizzle-kit';

// Lite profile: build the schema.ts head directly into an embedded PGlite data
// directory. This is the canonical schema (what the repositories are typed
// against) — the atlas/migrations startup pass is a secondary tracker that has
// drifted from head, so lite owns its schema via drizzle-kit (like ryzen).
//
// push must run against a FRESH dir (dev-lite.sh guards this): a non-empty dir
// makes drizzle-kit try to reconcile the diff and prompt for a TTY.
export default {
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	driver: 'pglite',
	dbCredentials: {
		url: resolve(process.env.PGLITE_DATA_DIR || './.pglite-data')
	}
} satisfies Config;
