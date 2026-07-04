import { db } from "$lib/server/db";
import { ApplicationEnvironmentService } from "$lib/server/application/environment-management";
import { LegacyEnvironmentRepository } from "$lib/server/application/adapters/environments";
import { PostgresEnvironmentMaintenanceRepository } from "$lib/server/application/adapters/environment-maintenance";

/**
 * Boot-time data backfill runner. Runs once per process via the module-level
 * promise below.
 *
 * Schema is owned entirely by drizzle — applied out-of-band BEFORE the app
 * boots: the `db-migrate` init container runs `pnpm db:migrate` (drizzle-kit) in
 * cluster, and the lite/PGlite profile runs `drizzle-kit push` of schema.ts head
 * (scripts/dev-lite.sh). The old in-app `atlas/migrations` pass was a drifted
 * secondary tracker (missing tables/columns vs head, some files failing even on
 * real Postgres) and has been retired — drizzle is the single schema owner. The
 * `atlas/*.sql` files are kept only as history; nothing runs them at boot.
 *
 * This runner now performs only idempotent DATA backfills (never schema):
 *   - link any agent without an environment_id to the default environment;
 *   - repair builtin sandbox images.
 *
 * No-op if DATABASE_URL is unset (`db` is null).
 */

async function runBackfills(): Promise<void> {
	if (!db) return;
	try {
		const environmentService = new ApplicationEnvironmentService(
			new LegacyEnvironmentRepository(),
			new PostgresEnvironmentMaintenanceRepository(),
		);
		const { report } = await environmentService.backfillDefault();
		if (report.defaultEnvironmentCreated || report.agentsLinked > 0) {
			console.log(
				`[startup] environments backfill: created=${report.defaultEnvironmentCreated}, linked=${report.agentsLinked}/${report.totalAgents}`,
			);
		}
		const { report: repairReport } = await environmentService.repairBuiltinSandboxImages();
		if (repairReport.updated > 0) {
			console.log(
				`[startup] builtin sandbox image repair (${repairReport.environmentName}): updated=${repairReport.updated}, cleared=${repairReport.cleared}, scanned=${repairReport.scanned}`,
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
