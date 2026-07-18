/**
 * Seed one non-terminal dev-environment workflow execution into the lite
 * PGlite data dir so `/workspaces/lite-dev-workspace/dev/<executionId>`
 * resolves (getDevEnvironmentOrPending finds a pending environment) for the
 * UI-evidence screenshot run. Run this while the dev server is STOPPED —
 * PGlite is single-process.
 *
 *   npx tsx tests/e2e/support/seed-exec.ts
 */
import { sql } from "drizzle-orm";
import { createPgliteDb } from "../../../src/lib/server/db/pglite-compat";

const EXECUTION_ID = "lite-dev-exec-evidence";
const WORKFLOW_ID = "lite-sample-workflow";
const USER_ID = "lite-dev-user";
const PROJECT_ID = "lite-dev-project";

async function main() {
	const dataDir = process.env.DATABASE_URL?.startsWith("pglite://")
		? process.env.DATABASE_URL.slice("pglite://".length)
		: "./.pglite-data";
	const { db, sql: rawSql } = createPgliteDb(dataDir);
	await db.execute(sql`
		INSERT INTO workflow_executions (id, workflow_id, user_id, project_id, status, input, started_at)
		VALUES (
			${EXECUTION_ID}, ${WORKFLOW_ID}, ${USER_ID}, ${PROJECT_ID}, 'running',
			${JSON.stringify({ services: ["workflow-builder"] })}::jsonb,
			now() - interval '42 minutes'
		)
		ON CONFLICT (id) DO NOTHING
	`);
	console.log(`[seed-exec] seeded execution ${EXECUTION_ID} (status=running)`);
	await rawSql.end();
}

main().catch((err) => {
	console.error("[seed-exec] failed:", err);
	process.exit(1);
});
