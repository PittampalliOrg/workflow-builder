import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	console.error('DATABASE_URL is required');
	process.exit(1);
}

// Session-level advisory lock so concurrent migrate runners serialize instead
// of racing on drizzle.__drizzle_migrations. Both the workflow-builder pod's
// `db-migrate` init container and the ArgoCD `db-migrate` Sync hook (and any
// extra replicas) call this script; the lock guarantees exactly one applies
// migrations at a time. max:1 keeps it on a single session so the lock spans
// the whole migrate. Arbitrary fixed key ("WB" schema migrations).
const MIGRATION_LOCK_KEY = 727274;

const client = postgres(databaseUrl, { max: 1 });

try {
	await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
	try {
		await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	} finally {
		await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
	}
} finally {
	await client.end({ timeout: 5 });
}
