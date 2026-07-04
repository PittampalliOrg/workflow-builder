/**
 * C1 spike: exercise the PGlite driver seam against the real migration SQL and
 * LISTEN/NOTIFY. Proves the compat shims (multi-statement .exec, transactions,
 * execute() result-shape, tagged-template + .listen on the raw sql client)
 * handle the atlas migration files and the two app NOTIFY channels.
 *
 * NOTE: this also SURFACED that the atlas set is a drifted secondary tracker
 * (missing tables/columns vs schema.ts head) — so the lite profile builds its
 * schema with `drizzle-kit push` (see scripts/dev-lite.sh), not this atlas pass.
 * The pass is kept here as a driver-compatibility proof and a drift check.
 *
 * Run: pnpm spike:pglite
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createPgliteDb } from "../src/lib/server/db/pglite-compat";

const MIGRATIONS_DIR = join(process.cwd(), "atlas/migrations");
const ATLAS_SUM = "atlas.sum";

async function main() {
	const { db, sql: rawSql } = createPgliteDb(); // in-memory, fresh

	// --- Migration pass: mirrors startup.ts runMigrations() exactly ---
	await db.execute(sql`
		CREATE TABLE IF NOT EXISTS "_app_migrations" (
			"migration_id" text PRIMARY KEY,
			"applied_at" timestamp NOT NULL DEFAULT now()
		)
	`);

	const tracked = await db.execute<{ migration_id: string }>(
		sql`SELECT migration_id FROM _app_migrations`,
	);
	// Exercises the array-style consumption (.map) from startup.ts:120.
	const trackedSet = new Set(tracked.map((r) => r.migration_id));
	console.log(`[spike] tracked migrations at start: ${trackedSet.size}`);

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && f !== ATLAS_SUM)
		.sort();
	console.log(`[spike] ${files.length} migration files to apply`);

	// Mirrors startup.ts LITE_SKIP_MIGRATIONS: atlas ALTERs whose CREATE lives
	// only in the drizzle journal (undefined_table on a from-scratch atlas DB).
	const LITE_SKIP = new Set([
		"20260419010000_drop_workflow_agent_events.sql",
		"20260423000000_agent_skill_registry_project_scope.sql",
	]);

	const applied: string[] = [];
	const skippedLite: string[] = [];
	const failed: { file: string; error: string }[] = [];
	for (const file of files) {
		if (trackedSet.has(file)) continue;
		if (LITE_SKIP.has(file)) {
			skippedLite.push(file);
			continue;
		}
		const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		try {
			await db.transaction(async (tx) => {
				await tx.execute(sql.raw(content)); // multi-statement -> PGlite .exec()
				await tx.execute(
					sql`INSERT INTO _app_migrations (migration_id) VALUES (${file})`,
				);
			});
			applied.push(file);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failed.push({ file, error: message });
			console.error(`[spike] FAILED ${file}: ${message}`);
		}
	}

	console.log(
		`\n[spike] MIGRATIONS: ${applied.length} applied, ${skippedLite.length} lite-skipped (atlas drift), ${failed.length} failed of ${files.length}`,
	);
	if (failed.length > 0) {
		console.log("[spike] failing files:");
		for (const f of failed) console.log(`  - ${f.file}: ${f.error}`);
	}

	// --- Type-fidelity checks for the parameterless-exec path ---
	const agentsExists = await db.execute<{ exists: boolean }>(
		sql`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema='public' AND table_name='agents'
		) AS exists`,
	);
	console.log(
		`[spike] agents table exists = ${agentsExists[0]?.exists} (type ${typeof agentsExists[0]?.exists})`,
	);

	const trackedAfter = await db.execute<{ migration_id: string }>(
		sql`SELECT migration_id FROM _app_migrations ORDER BY migration_id`,
	);
	console.log(`[spike] _app_migrations rows after: ${trackedAfter.length}`);

	const countRow = await db.execute<{ n: number }>(
		sql`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'`,
	);
	console.log(
		`[spike] public tables = ${countRow[0]?.n} (type ${typeof countRow[0]?.n})`,
	);

	// --- Raw sql tagged-template parity (execution-read-model-support.ts) ---
	const cols = await rawSql<{ column_name: string }[]>`
		select column_name from information_schema.columns
		where table_schema = 'public' and table_name = 'workflow_executions'
	`;
	const colNames = new Set((cols as { column_name: string }[]).map((r) => r.column_name));
	const needed = ["current_node_id", "current_node_name", "primary_trace_id", "workflow_session_id", "summary_output"];
	console.log(
		`[spike] workflow_executions read-model columns present: ${needed.filter((c) => colNames.has(c)).length}/${needed.length}`,
	);

	// --- LISTEN/NOTIFY round-trip on both app channels ---
	for (const channel of ["session_events", "gitops_activity_events"]) {
		const got = await new Promise<string | null>((resolve) => {
			const timer = setTimeout(() => resolve(null), 3000);
			rawSql
				.listen(channel, (payload: string) => {
					clearTimeout(timer);
					resolve(payload);
				})
				.then(async () => {
					// pg_notify from a second query on the same connection.
					await db.execute(sql.raw(`NOTIFY ${channel}, 'ping-${channel}'`));
				});
		});
		console.log(
			`[spike] LISTEN/NOTIFY ${channel}: ${got === `ping-${channel}` ? "OK" : `FAIL (got ${JSON.stringify(got)})`}`,
		);
	}

	const ok = failed.length === 0;
	console.log(`\n[spike] VERDICT: ${ok ? "PASS" : "FAIL"}`);
	process.exit(ok ? 0 : 1);
}

main().catch((err) => {
	console.error("[spike] fatal:", err);
	process.exit(2);
});
