import postgres from "postgres";
import {
	selectSwebenchDaprStateKeysForRepair,
	swebenchDaprRepairDecision,
} from "../src/lib/server/benchmarks/dapr-state-repair";

type Args = {
	apply: boolean;
	instanceId: string | null;
	minAgeHours: number;
	limit: number;
	restart: boolean;
};

type Candidate = {
	instance_id: string;
	age_hours: number | null;
	keys: string[];
	child_instance_ids: string[];
};

function usage(): never {
	console.log(
		[
			"Usage:",
			"  DATABASE_URL=... pnpm repair:swebench-dapr-state --dry-run",
			"  DATABASE_URL=... pnpm repair:swebench-dapr-state --instance sw-swebench-instance-exec-... --apply",
			"",
			"Deletes only benchmark-owned wfstate_state rows matching a stuck SWE-bench parent and its deterministic child/session keys.",
			"Refuses benchmark repair while active benchmark runs or active benchmark leases exist.",
		].join("\n"),
	);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		instanceId: null,
		minAgeHours: 6,
		limit: 25,
		restart: true,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--apply") args.apply = true;
		else if (arg === "--dry-run") args.apply = false;
		else if (arg === "--instance") args.instanceId = required(argv, ++i, arg);
		else if (arg === "--min-age-hours")
			args.minAgeHours = Number(required(argv, ++i, arg));
		else if (arg === "--limit") args.limit = Number(required(argv, ++i, arg));
		else if (arg === "--no-restart") args.restart = false;
		else if (arg === "--help" || arg === "-h") usage();
		else usage();
	}
	if (!Number.isFinite(args.minAgeHours) || args.minAgeHours < 0) usage();
	if (!Number.isInteger(args.limit) || args.limit < 1) usage();
	return args;
}

function required(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

async function activeBenchmarkCounts(sql: postgres.Sql) {
	const [runs] = await sql<{ count: number }[]>`
		SELECT COUNT(*)::int AS count
		FROM benchmark_runs
		WHERE status IN ('queued', 'inferencing', 'evaluating')
	`;
	const [leases] = await sql<{ count: number }[]>`
		SELECT COUNT(*)::int AS count
		FROM benchmark_resource_leases
		WHERE status = 'active'
	`;
	return {
		activeRunCount: runs?.count ?? 0,
		activeLeaseCount: leases?.count ?? 0,
	};
}

async function loadCandidates(sql: postgres.Sql, args: Args): Promise<Candidate[]> {
	const parentRows = args.instanceId
		? [{ instance_id: args.instanceId }]
		: await sql<{ instance_id: string }[]>`
				SELECT DISTINCT split_part(key, '||', 2) AS instance_id
				FROM wfstate_state
				WHERE split_part(key, '||', 2) LIKE 'sw-swebench-instance-exec-%'
				ORDER BY instance_id
				LIMIT ${args.limit}
			`;
	const candidates: Candidate[] = [];
	for (const row of parentRows) {
		const instanceId = row.instance_id;
		const keyRows = await sql<{ key: string; age_hours: number | null }[]>`
			SELECT key, EXTRACT(EPOCH FROM (NOW() - updated_at)) / 3600.0 AS age_hours
			FROM wfstate_state
			WHERE key LIKE ${`%||${instanceId}||%`}
				OR key LIKE ${`%||${instanceId}__durable__%`}
			ORDER BY updated_at DESC
		`;
		const childRows = await sql<{ child_instance_id: string }[]>`
			SELECT DISTINCT child_instance_id
			FROM (
				SELECT session_id AS child_instance_id
				FROM benchmark_run_instances
				WHERE dapr_instance_id = ${instanceId}
					OR workflow_execution_id IN (
						SELECT id FROM workflow_executions WHERE dapr_instance_id = ${instanceId}
					)
				UNION
				SELECT sessions.id AS child_instance_id
				FROM sessions
				JOIN workflow_executions ON workflow_executions.id = sessions.workflow_execution_id
				WHERE workflow_executions.dapr_instance_id = ${instanceId}
			) children
			WHERE child_instance_id IS NOT NULL
		`;
		candidates.push({
			instance_id: instanceId,
			age_hours:
				keyRows.length === 0
					? null
					: Math.max(...keyRows.map((key) => Number(key.age_hours ?? 0))),
			keys: keyRows.map((key) => key.key),
			child_instance_ids: childRows.map((child) => child.child_instance_id),
		});
	}
	return candidates;
}

async function restartWorkflowOrchestrator() {
	const { spawnSync } = await import("node:child_process");
	const result = spawnSync(
		"kubectl",
		[
			"rollout",
			"restart",
			"deployment/workflow-orchestrator",
			"-n",
			"workflow-builder",
		],
		{ stdio: "inherit" },
	);
	if (result.status !== 0) {
		throw new Error(`kubectl rollout restart failed with status ${result.status}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	const sql = postgres(databaseUrl, { max: 1 });
	try {
		const counts = await activeBenchmarkCounts(sql);
		const candidates = await loadCandidates(sql, args);
		let deleted = 0;
		for (const candidate of candidates) {
			const decision = swebenchDaprRepairDecision({
				instanceId: candidate.instance_id,
				ageHours: candidate.age_hours,
				activeRunCount: counts.activeRunCount,
				activeLeaseCount: counts.activeLeaseCount,
				minAgeHours: args.minAgeHours,
			});
			const keys = selectSwebenchDaprStateKeysForRepair({
				keys: candidate.keys,
				parentInstanceId: candidate.instance_id,
				childInstanceIds: candidate.child_instance_ids,
			});
			console.log(
				JSON.stringify({
					instanceId: candidate.instance_id,
					decision,
					keyCount: keys.length,
					childInstanceIds: candidate.child_instance_ids,
					apply: args.apply,
				}),
			);
			if (!decision.repair || keys.length === 0 || !args.apply) continue;
			const result = await sql<{ count: number }[]>`
				DELETE FROM wfstate_state
				WHERE key IN ${sql(keys)}
				RETURNING 1 AS count
			`;
			deleted += result.length;
		}
		console.log(JSON.stringify({ deleted, apply: args.apply }));
		if (args.apply && deleted > 0 && args.restart) {
			await restartWorkflowOrchestrator();
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
