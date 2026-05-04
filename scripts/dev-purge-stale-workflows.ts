import postgres from "postgres";

type Target =
	| { kind: "workflow"; instanceId: string }
	| { kind: "agent"; runtimeAppId: string; instanceId: string };

function usage(): never {
	console.error(
		[
			"Usage:",
			"  pnpm dev:purge-stale-workflows --workflow <instanceId> [--workflow <instanceId>]",
			"  pnpm dev:purge-stale-workflows --agent <runtimeAppId>:<instanceId>",
			"",
			"Guards:",
			"  Requires DATABASE_URL.",
			"  Refuses to run while benchmark_runs or benchmark_resource_leases are active.",
			"  Set DEV_STALE_WORKFLOW_PURGE_FORCE=1 only for already-terminated-but-stuck instances.",
		].join("\n"),
	);
	process.exit(2);
}

function parseTargets(argv: string[]): Target[] {
	const targets: Target[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--workflow") {
			const instanceId = argv[++i]?.trim();
			if (!instanceId) usage();
			targets.push({ kind: "workflow", instanceId });
			continue;
		}
		if (arg === "--agent") {
			const value = argv[++i]?.trim();
			if (!value || !value.includes(":")) usage();
			const [runtimeAppId, ...rest] = value.split(":");
			const instanceId = rest.join(":").trim();
			if (!runtimeAppId.trim() || !instanceId) usage();
			targets.push({
				kind: "agent",
				runtimeAppId: runtimeAppId.trim(),
				instanceId,
			});
			continue;
		}
		usage();
	}
	if (targets.length === 0) usage();
	return targets;
}

async function assertNoActiveBenchmarks(sql: postgres.Sql) {
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
	if ((runs?.count ?? 0) > 0 || (leases?.count ?? 0) > 0) {
		throw new Error(
			`Refusing stale workflow purge while active benchmarks exist: runs=${runs?.count ?? 0}, leases=${leases?.count ?? 0}`,
		);
	}
}

async function deleteOrThrow(url: string) {
	const res = await fetch(url, { method: "DELETE" });
	if (res.ok || res.status === 404) return;
	const detail = await res.text().catch(() => "");
	throw new Error(`${res.status} ${detail.slice(0, 500)}`);
}

async function main() {
	const targets = parseTargets(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	const force = process.env.DEV_STALE_WORKFLOW_PURGE_FORCE === "1";
	const orchestratorUrl =
		process.env.WORKFLOW_ORCHESTRATOR_URL ?? "http://127.0.0.1:8000";
	const daprUrl =
		process.env.DAPR_HTTP_ENDPOINT ??
		`http://${process.env.DAPR_HOST ?? "127.0.0.1"}:${process.env.DAPR_HTTP_PORT ?? "3500"}`;

	const sql = postgres(databaseUrl, { max: 1 });
	try {
		await assertNoActiveBenchmarks(sql);
		for (const target of targets) {
			if (target.kind === "workflow") {
				const url = `${orchestratorUrl.replace(/\/$/, "")}/api/v2/workflows/${encodeURIComponent(
					target.instanceId,
				)}?force=${force ? "true" : "false"}&recursive=true`;
				await deleteOrThrow(url);
				console.log(`purged workflow ${target.instanceId}`);
			} else {
				const url = `${daprUrl.replace(/\/$/, "")}/v1.0/invoke/${encodeURIComponent(
					target.runtimeAppId,
				)}/method/api/v2/agent-runs/${encodeURIComponent(
					target.instanceId,
				)}?force=${force ? "true" : "false"}&recursive=true`;
				await deleteOrThrow(url);
				console.log(
					`purged agent workflow ${target.runtimeAppId}/${target.instanceId}`,
				);
			}
		}
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
