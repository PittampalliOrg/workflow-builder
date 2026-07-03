import { env } from "$env/dynamic/private";
import postgres from "postgres";
import type {
	PreviewDatabaseProvisioner,
	PreviewDatabaseProvisionResult,
} from "$lib/server/application/ports";

/**
 * Per-preview database isolation. A functional dev preview gets its own
 * `preview_<id>` database on the shared dev Postgres server. The app then
 * self-migrates the empty DB on boot via startup.ts.
 */
export class PostgresPreviewDatabaseProvisioner
	implements PreviewDatabaseProvisioner
{
	async provision(input: {
		executionId: string;
	}): Promise<PreviewDatabaseProvisionResult> {
		const { adminUrl, previewUrl, dbName, sourceUrl } = resolveUrls(
			input.executionId,
		);
		const sql = postgres(adminUrl, { max: 1 });
		try {
			const exists =
				await sql`select 1 from pg_database where datname = ${dbName} limit 1`;
			if (exists.length === 0) {
				await sql.unsafe(`CREATE DATABASE "${dbName}"`);
			}
		} finally {
			await sql.end({ timeout: 5 });
		}
		return { databaseUrl: previewUrl, sourceUrl, dbName };
	}

	async drop(input: { executionId: string }): Promise<void> {
		const { adminUrl, dbName } = resolveUrls(input.executionId);
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
}

function resolveUrls(executionId: string): {
	adminUrl: string;
	previewUrl: string;
	sourceUrl: string;
	dbName: string;
} {
	const base = env.DATABASE_URL;
	if (!base) {
		throw new Error("DATABASE_URL not configured (cannot provision preview DB)");
	}
	const dbName = safeDbName(executionId);
	const admin = new URL(base);
	admin.pathname = "/postgres";
	const preview = new URL(base);
	preview.pathname = `/${dbName}`;
	return {
		adminUrl: admin.toString(),
		previewUrl: preview.toString(),
		sourceUrl: base,
		dbName,
	};
}

/** Sanitize an execution id into a valid lowercase Postgres db name. */
function safeDbName(executionId: string): string {
	const s = executionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 50);
	return `preview_${s || "env"}`;
}
