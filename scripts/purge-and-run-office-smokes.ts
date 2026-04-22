/**
 * Purge stale running workflow executions and kick off the excel + powerpoint
 * smoke workflows. Used to validate the streaming-enhancement deploy.
 *
 * Runs inside the workflow-builder pod (DATABASE_URL comes from
 * workflow-builder-secrets via envFrom):
 *   pnpm tsx scripts/purge-and-run-office-smokes.ts
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL!;
const ORCH =
	process.env.GENERIC_ORCHESTRATOR_URL ??
	"http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080";

type RunRow = {
	id: string;
	workflow_id: string;
	status: string;
	dapr_instance_id: string | null;
	started_at: Date | null;
};

async function listStale(sql: postgres.Sql) {
	return sql<RunRow[]>`
		SELECT id, workflow_id, status, dapr_instance_id, started_at
		FROM workflow_executions
		WHERE status IN ('running', 'scheduled')
		ORDER BY started_at DESC NULLS LAST
	`;
}

async function terminate(sql: postgres.Sql, row: RunRow) {
	const instance = row.dapr_instance_id || row.id;
	try {
		const res = await fetch(
			`${ORCH}/api/v2/workflows/${instance}/terminate`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					reason: "purged for streaming-enhancement smoke test",
				}),
				signal: AbortSignal.timeout(5000),
			},
		);
		const text = await res.text().catch(() => "");
		console.log(
			`terminate ${row.id} (${row.workflow_id}, instance=${instance}): HTTP ${res.status} ${text.slice(0, 120)}`,
		);
	} catch (err) {
		console.log(
			`terminate ${row.id} failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	await sql`
		UPDATE workflow_executions
		SET status = 'cancelled', completed_at = NOW()
		WHERE id = ${row.id}
	`;
}

async function trigger(sql: postgres.Sql, workflowId: string): Promise<string> {
	const w = await sql<{
		id: string;
		spec: unknown;
		user_id: string;
		project_id: string | null;
	}[]>`SELECT id, spec, user_id, project_id FROM workflows WHERE id = ${workflowId}`;
	if (!w[0]) throw new Error(`workflow ${workflowId} not found`);
	const alphabet =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
	const bytes = new Uint8Array(21);
	crypto.getRandomValues(bytes);
	const execId = Array.from(bytes, (b) => alphabet[b & 63]).join("");
	const [exec] = await sql<{ id: string }[]>`
		INSERT INTO workflow_executions (id, workflow_id, user_id, status, input, project_id, started_at)
		VALUES (${execId}, ${workflowId}, ${w[0].user_id}, 'running', '{}', ${w[0].project_id}, NOW())
		RETURNING id
	`;
	const res = await fetch(`${ORCH}/api/v2/sw-workflows`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			workflow: w[0].spec,
			workflowId,
			triggerData: {},
			dbExecutionId: exec.id,
		}),
	});
	const body = await res.text();
	if (!res.ok) {
		await sql`UPDATE workflow_executions SET status = 'error', error = ${body.slice(0, 500)} WHERE id = ${exec.id}`;
		throw new Error(`orchestrator ${res.status}: ${body}`);
	}
	const j = JSON.parse(body) as { instanceId: string };
	await sql`
		UPDATE workflow_executions
		SET dapr_instance_id = ${j.instanceId}, workflow_session_id = ${exec.id}
		WHERE id = ${exec.id}
	`;
	console.log(`TRIGGERED ${workflowId}: exec=${exec.id} instance=${j.instanceId}`);
	return exec.id;
}

async function main() {
	const sql = postgres(DATABASE_URL, { max: 1 });
	try {
		console.log("=== stale workflow_executions (status in running/scheduled) ===");
		const stale = await listStale(sql);
		console.log(`found ${stale.length} stale`);
		for (const row of stale) {
			console.log(
				`  - ${row.id} wf=${row.workflow_id} status=${row.status} started=${row.started_at?.toISOString() ?? "?"} instance=${row.dapr_instance_id ?? "-"}`,
			);
		}
		console.log("=== terminating ===");
		for (const row of stale) {
			await terminate(sql, row);
		}
		console.log("=== triggering smokes ===");
		const ids = await Promise.all([
			trigger(sql, "excel-agent-smoke"),
			trigger(sql, "powerpoint-agent-smoke"),
		]);
		console.log("DONE. exec ids:", ids.join(" "));
	} finally {
		await sql.end();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
