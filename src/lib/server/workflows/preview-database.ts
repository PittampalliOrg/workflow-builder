import { env } from "$env/dynamic/private";
import postgres from "postgres";

/**
 * Per-preview database isolation. A functional dev preview gets its OWN Postgres
 * database `preview_<id>` on the SHARED dev Postgres server (cheap: one CREATE
 * DATABASE; the app self-migrates the empty DB on boot via startup.ts). Dropped
 * on teardown. The preview's DATABASE_URL is delivered to the pod via a
 * per-preview Secret (sandbox-execution-api), never plaintext in the CR.
 */

/** Sanitize an execution id into a valid lowercase Postgres db name. */
function safeDbName(executionId: string): string {
	const s = executionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
	return `preview_${s || "env"}`;
}

function resolveUrls(executionId: string): {
	adminUrl: string;
	previewUrl: string;
	dbName: string;
} {
	const base = env.DATABASE_URL;
	if (!base) throw new Error("DATABASE_URL not configured (cannot provision preview DB)");
	const dbName = safeDbName(executionId);
	// Connect to the `postgres` maintenance DB for CREATE/DROP (can't run those
	// while connected to the target DB).
	const admin = new URL(base);
	admin.pathname = "/postgres";
	const preview = new URL(base);
	preview.pathname = `/${dbName}`;
	return { adminUrl: admin.toString(), previewUrl: preview.toString(), dbName };
}

/** CREATE DATABASE preview_<id> (idempotent); returns its DATABASE_URL. */
export async function provisionPreviewDatabase(
	executionId: string,
): Promise<{ databaseUrl: string; dbName: string }> {
	const { adminUrl, previewUrl, dbName } = resolveUrls(executionId);
	const sql = postgres(adminUrl, { max: 1 });
	try {
		const exists =
			await sql`select 1 from pg_database where datname = ${dbName} limit 1`;
		if (exists.length === 0) {
			// dbName is alnum-sanitized above, so interpolation is injection-safe.
			await sql.unsafe(`CREATE DATABASE "${dbName}"`);
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
	return { databaseUrl: previewUrl, dbName };
}

/** Terminate connections + DROP DATABASE preview_<id> (best-effort). */
export async function dropPreviewDatabase(executionId: string): Promise<void> {
	const { adminUrl, dbName } = resolveUrls(executionId);
	const sql = postgres(adminUrl, { max: 1 });
	try {
		await sql.unsafe(
			`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${dbName}' and pid <> pg_backend_pid()`,
		);
		await sql.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
	} catch (err) {
		console.warn(
			`[preview-database] drop ${dbName} failed:`,
			err instanceof Error ? err.message : err,
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}
