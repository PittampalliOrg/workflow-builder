import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { backfillDefaultEnvironment } from "$lib/server/environments/backfill";

/**
 * Boot-time migration + backfill runner. Runs once per process via the
 * module-level promise below.
 *
 * Behavior:
 *   1. Ensure an `_app_migrations` tracking table exists.
 *   2. If it's empty AND the `agents` table already exists (pre-CMA state),
 *      seed every migration file that predates our CMA-era migrations as
 *      "already applied" — this is the first-boot catch-up for DBs that
 *      were previously migrated out-of-band via atlas.
 *   3. Apply any migration file in `atlas/migrations/` whose basename is
 *      not in the tracking table, inside a transaction.
 *   4. Run the default-environment backfill (idempotent) so any agent
 *      without an environment_id gets linked to the default.
 *
 * No-op if DATABASE_URL is unset.
 */

const MIGRATIONS_DIR = join(process.cwd(), "atlas/migrations");
const ATLAS_SUM = "atlas.sum";

// Migrations that predate the CMA refactor. On a first boot where the
// tracking table is empty but `agents` already exists, we mark these as
// applied so we don't try to re-run them.
const PRE_CMA_MIGRATIONS = new Set([
	"20260210204758_baseline.sql",
	"20260212120000_add_workflow_ai_messages.sql",
	"20260217110505_add_resource_library_resources.sql",
	"20260217112436_add_model_catalog_tables.sql",
	"20260217123258_add_agent_profile_templates.sql",
	"20260217181500_add_durable_plan_and_session_tables.sql",
	"20260217200000_add_workspace_change_artifact_files.sql",
	"20260219103000_add_workflow_ai_tool_messages.sql",
	"20260219143000_add_mcp_connections.sql",
	"20260220113000_upgrade_coding_agent_profile_for_opencode.sql",
	"20260223120000_set_claude_plan_artifact_default.sql",
	"20260223150000_add_sandbox_state_column.sql",
	"20260310143000_add_workflow_execution_rerun_fields.sql",
	"20260404153000_add_code_functions.sql",
	"20260404183000_add_code_function_revisions_and_supporting_files.sql",
	"20260408120000_add_execution_read_model_columns.sql",
	"20260413174500_add_mcp_connection_external_id.sql",
	"20260417080000_extend_model_catalog.sql",
	"20260418100000_add_named_agents.sql",
]);

async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
	if (!db) return { applied: [], skipped: [] };

	await db.execute(sql`
		CREATE TABLE IF NOT EXISTS "_app_migrations" (
			"migration_id" text PRIMARY KEY,
			"applied_at" timestamp NOT NULL DEFAULT now()
		)
	`);

	const tracked = await db.execute<{ migration_id: string }>(
		sql`SELECT migration_id FROM _app_migrations`,
	);
	const trackedSet = new Set(tracked.map((r) => r.migration_id));

	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql") && f !== ATLAS_SUM)
		.sort();

	// First-boot catch-up: if tracking table is empty and `agents` exists,
	// seed pre-CMA migrations as applied.
	if (trackedSet.size === 0) {
		const agentsExists = await db.execute<{ exists: boolean }>(
			sql`SELECT EXISTS (
				SELECT 1 FROM information_schema.tables
				WHERE table_schema='public' AND table_name='agents'
			) AS exists`,
		);
		if (agentsExists[0]?.exists) {
			for (const file of files) {
				if (PRE_CMA_MIGRATIONS.has(file)) {
					await db.execute(
						sql`INSERT INTO _app_migrations (migration_id) VALUES (${file}) ON CONFLICT DO NOTHING`,
					);
					trackedSet.add(file);
				}
			}
		}
	}

	const applied: string[] = [];
	const skipped: string[] = [];
	for (const file of files) {
		if (trackedSet.has(file)) {
			skipped.push(file);
			continue;
		}
		const content = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
		try {
			await db.transaction(async (tx) => {
				await tx.execute(sql.raw(content));
				await tx.execute(
					sql`INSERT INTO _app_migrations (migration_id) VALUES (${file})`,
				);
			});
			applied.push(file);
			console.log(`[startup] applied migration ${file}`);
		} catch (err) {
			console.error(`[startup] migration ${file} failed:`, err);
			throw err;
		}
	}
	return { applied, skipped };
}

async function runBackfills(): Promise<void> {
	if (!db) return;
	try {
		const report = await backfillDefaultEnvironment();
		if (report.defaultEnvironmentCreated || report.agentsLinked > 0) {
			console.log(
				`[startup] environments backfill: created=${report.defaultEnvironmentCreated}, linked=${report.agentsLinked}/${report.totalAgents}`,
			);
		}
	} catch (err) {
		console.error("[startup] environments backfill failed:", err);
	}
}

let startupPromise: Promise<void> | null = null;

export function ensureStartupReady(): Promise<void> {
	if (!startupPromise) {
		startupPromise = (async () => {
			try {
				const { applied, skipped } = await runMigrations();
				if (applied.length > 0) {
					console.log(
						`[startup] migrations: ${applied.length} applied, ${skipped.length} already up to date`,
					);
				}
				await runBackfills();
			} catch (err) {
				console.error(
					"[startup] boot sequence failed — requests may 500 until fixed:",
					err,
				);
				// Reset so a subsequent request retries, instead of sticking with a failed promise.
				startupPromise = null;
				throw err;
			}
		})();
	}
	return startupPromise;
}
