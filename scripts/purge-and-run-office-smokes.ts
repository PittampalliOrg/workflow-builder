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
// Smokes start through the BFF's canonical start path (engine-agnostic:
// SW today, dynamic-script after the cutover port) — never by fabricating
// workflow_executions rows + posting specs at the orchestrator directly
// (cutover P3, docs/code-first-cutover.md item 15).
const BFF = process.env.WORKFLOW_BUILDER_URL ?? "http://localhost:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN!;

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

async function trigger(workflowId: string): Promise<string> {
	const res = await fetch(`${BFF}/api/internal/agent/workflows/execute`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-internal-token": INTERNAL_API_TOKEN,
		},
		body: JSON.stringify({ workflowId, triggerData: {} }),
		signal: AbortSignal.timeout(30_000),
	});
	const body = await res.text();
	if (!res.ok) {
		throw new Error(`execute ${workflowId}: HTTP ${res.status}: ${body.slice(0, 300)}`);
	}
	const j = JSON.parse(body) as { executionId: string; instanceId?: string };
	console.log(
		`TRIGGERED ${workflowId}: exec=${j.executionId} instance=${j.instanceId ?? "-"}`,
	);
	return j.executionId;
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
			trigger("excel-agent-smoke"),
			trigger("powerpoint-agent-smoke"),
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
