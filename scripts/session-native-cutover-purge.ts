/**
 * Full cutover cleanup for the session-native Dapr agent loop.
 *
 * Dry-run by default:
 *   pnpm session-native:cutover-purge
 *
 * Apply against the configured dev environment:
 *   pnpm session-native:cutover-purge -- --apply
 *
 * Required for DB work: DATABASE_URL.
 * Required for Dapr work: DAPR_HTTP_ENDPOINT, or DAPR_HOST/DAPR_HTTP_PORT.
 */

import postgres from "postgres";
import { spawnSync } from "node:child_process";

const ACTIVE_SESSION_STATUSES = ["rescheduling", "running", "idle"] as const;
const DEFAULT_RUNTIME_APP_ID = "dapr-agent-py";
const DEFAULT_STATE_TABLE = "agent_py_state";
const DEFAULT_MAX_SYNTHETIC_TURNS = 1000;

type Args = {
	apply: boolean;
	force: boolean;
	sessionIds: string[];
	interactiveOnly: boolean;
	skipDapr: boolean;
	skipStateDelete: boolean;
	restartRuntimes: boolean;
	namespace: string;
	defaultRuntimeAppId: string;
	stateTable: string;
	maxSyntheticTurns: number;
	terminateWaitSeconds: number;
	reason: string;
};

type SessionRow = {
	id: string;
	status: string;
	runtimeAppId: string | null;
	daprInstanceId: string | null;
	workflowExecutionId: string | null;
};

type SessionEventRow = {
	sessionId: string;
	type: string;
	data: unknown;
};

type CleanupTarget = {
	session: SessionRow;
	runtimeAppId: string;
	instanceIds: string[];
	stateDeleteKeys: string[];
};

function usage(exitCode = 2): never {
	console.error(
		[
			"Usage:",
			"  pnpm session-native:cutover-purge [-- --apply]",
			"  pnpm session-native:cutover-purge -- --session <sessionId> [--session <sessionId>]",
			"",
			"Options:",
			"  --apply                         Execute updates, Dapr cleanup, and state deletes.",
			"  --force                         Pass force=true to Dapr purge endpoints.",
			"  --interactive-only              Only include sessions without workflow_execution_id.",
			"  --skip-dapr                     Only update DB/state; do not call Dapr endpoints.",
			"  --skip-state-delete             Keep agent_py_state runtime-context rows.",
			"  --restart-runtimes              kubectl rollout restart touched runtime deployments after cleanup.",
			"  --namespace <name>              Namespace for --restart-runtimes (default workflow-builder).",
			"  --default-runtime-app-id <id>   Fallback runtime app id (default dapr-agent-py).",
			"  --state-table <name>            Dapr state table name (default agent_py_state).",
			"  --max-synthetic-turns <n>       Cap legacy :turn-N ids synthesized from events (default 1000).",
			"  --terminate-wait-seconds <n>    Wait for terminal/missing status after terminate (default 30).",
			"  --reason <text>                 Human reason stored in sessions.stop_reason.",
			"",
			"Guards:",
			"  Requires DATABASE_URL.",
			"  Refuses to run while benchmark_runs or benchmark_resource_leases are active unless --force is set.",
			"  Dry-run is the default.",
		].join("\n"),
	);
	process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		force: false,
		sessionIds: [],
		interactiveOnly: false,
		skipDapr: false,
		skipStateDelete: false,
		restartRuntimes: false,
		namespace: process.env.KUBE_NAMESPACE ?? "workflow-builder",
		defaultRuntimeAppId:
			process.env.DEFAULT_AGENT_RUNTIME_APP_ID ?? DEFAULT_RUNTIME_APP_ID,
		stateTable: process.env.DAPR_AGENT_STATE_TABLE ?? DEFAULT_STATE_TABLE,
		maxSyntheticTurns: DEFAULT_MAX_SYNTHETIC_TURNS,
		terminateWaitSeconds: 30,
		reason: "Session-native Dapr agent workflow cutover purge",
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--") continue;
		if (arg === "--help" || arg === "-h") usage(0);
		if (arg === "--apply") {
			args.apply = true;
			continue;
		}
		if (arg === "--force") {
			args.force = true;
			continue;
		}
		if (arg === "--interactive-only") {
			args.interactiveOnly = true;
			continue;
		}
		if (arg === "--skip-dapr") {
			args.skipDapr = true;
			continue;
		}
		if (arg === "--skip-state-delete") {
			args.skipStateDelete = true;
			continue;
		}
		if (arg === "--restart-runtimes") {
			args.restartRuntimes = true;
			continue;
		}
		if (arg === "--session") {
			const value = argv[++i]?.trim();
			if (!value) usage();
			args.sessionIds.push(value);
			continue;
		}
		if (arg === "--namespace") {
			const value = argv[++i]?.trim();
			if (!value) usage();
			args.namespace = value;
			continue;
		}
		if (arg === "--default-runtime-app-id") {
			const value = argv[++i]?.trim();
			if (!value) usage();
			args.defaultRuntimeAppId = value;
			continue;
		}
		if (arg === "--state-table") {
			const value = argv[++i]?.trim();
			if (!isSafeIdentifier(value)) usage();
			args.stateTable = value;
			continue;
		}
		if (arg === "--max-synthetic-turns") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 0) usage();
			args.maxSyntheticTurns = value;
			continue;
		}
		if (arg === "--terminate-wait-seconds") {
			const value = Number(argv[++i]);
			if (!Number.isInteger(value) || value < 0) usage();
			args.terminateWaitSeconds = value;
			continue;
		}
		if (arg === "--reason") {
			const value = argv[++i]?.trim();
			if (!value) usage();
			args.reason = value;
			continue;
		}
		usage();
	}
	return args;
}

function isSafeIdentifier(value: string | undefined): value is string {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value ?? "");
}

function daprEndpoint(): string {
	return (
		process.env.DAPR_HTTP_ENDPOINT ??
		`http://${process.env.DAPR_HOST ?? "127.0.0.1"}:${process.env.DAPR_HTTP_PORT ?? "3500"}`
	).replace(/\/+$/, "");
}

function eventData(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function turnNumberFromValue(sessionId: string, value: unknown): number | null {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return null;
	if (/^\d+$/.test(text)) return Number(text);
	const match = text.match(new RegExp(`^${escapeRegExp(sessionId)}:turn-(\\d+)$`));
	if (!match) return null;
	const parsed = Number(match[1]);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function instanceIdsForSession(
	session: SessionRow,
	events: SessionEventRow[],
	maxSyntheticTurns: number,
): string[] {
	const ids = new Set<string>();
	ids.add(session.daprInstanceId?.trim() || session.id);
	ids.add(session.id);
	let maxTurn = 0;
	for (const row of events) {
		const data = eventData(row.data);
		for (const key of ["childInstanceId", "child_instance_id", "workflowInstanceId"]) {
			const value = data[key];
			if (typeof value === "string" && value.trim()) ids.add(value.trim());
		}
		for (const key of ["turn", "turnId", "turn_id", "childInstanceId", "child_instance_id"]) {
			const turn = turnNumberFromValue(session.id, data[key]);
			if (turn && turn > maxTurn) maxTurn = turn;
		}
	}
	const bounded = Math.min(maxTurn, maxSyntheticTurns);
	for (let turn = 1; turn <= bounded; turn += 1) {
		ids.add(`${session.id}:turn-${turn}`);
	}
	return [...ids].filter(Boolean).sort();
}

function stateKeysForSession(sessionId: string, instanceIds: string[]): string[] {
	return instanceIds
		.filter((id) => id.startsWith(`${sessionId}:turn-`))
		.map((id) => `runtime-context:${id}`)
		.sort();
}

async function assertNoActiveBenchmarks(sql: postgres.Sql, force: boolean) {
	if (force) return;
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
			`Refusing session-native cutover purge while active benchmarks exist: runs=${runs?.count ?? 0}, leases=${leases?.count ?? 0}. Re-run with --force only after deliberately stopping benchmark traffic.`,
		);
	}
}

async function loadSessions(sql: postgres.Sql, args: Args): Promise<SessionRow[]> {
	const statusFilter = [...ACTIVE_SESSION_STATUSES];
	const rows = await sql<SessionRow[]>`
		SELECT
			id,
			status,
			runtime_app_id AS "runtimeAppId",
			dapr_instance_id AS "daprInstanceId",
			workflow_execution_id AS "workflowExecutionId"
		FROM sessions
		WHERE status IN ${sql(statusFilter)}
			${args.sessionIds.length > 0 ? sql`AND id IN ${sql(args.sessionIds)}` : sql``}
			${args.interactiveOnly ? sql`AND workflow_execution_id IS NULL` : sql``}
		ORDER BY updated_at ASC
	`;
	return rows;
}

async function loadSessionEvents(
	sql: postgres.Sql,
	sessionIds: string[],
): Promise<SessionEventRow[]> {
	if (sessionIds.length === 0) return [];
	return sql<SessionEventRow[]>`
		SELECT session_id AS "sessionId", type, data
		FROM session_events
		WHERE session_id IN ${sql(sessionIds)}
			AND (
				data ? 'turn'
				OR data ? 'turnId'
				OR data ? 'turn_id'
				OR data ? 'childInstanceId'
				OR data ? 'child_instance_id'
				OR data ? 'workflowInstanceId'
			)
		ORDER BY session_id ASC, sequence ASC
	`;
}

function buildTargets(
	sessions: SessionRow[],
	events: SessionEventRow[],
	args: Args,
): CleanupTarget[] {
	const eventsBySession = new Map<string, SessionEventRow[]>();
	for (const event of events) {
		const current = eventsBySession.get(event.sessionId) ?? [];
		current.push(event);
		eventsBySession.set(event.sessionId, current);
	}
	return sessions.map((session) => {
		const instanceIds = instanceIdsForSession(
			session,
			eventsBySession.get(session.id) ?? [],
			args.maxSyntheticTurns,
		);
		return {
			session,
			runtimeAppId:
				session.runtimeAppId?.trim() || args.defaultRuntimeAppId.trim(),
			instanceIds,
			stateDeleteKeys: stateKeysForSession(session.id, instanceIds),
		};
	});
}

async function invokeDapr(
	runtimeAppId: string,
	instanceId: string,
	operation: "terminate" | "purge",
	args: Args,
): Promise<void> {
	const encodedApp = encodeURIComponent(runtimeAppId);
	const encodedInstance = encodeURIComponent(instanceId);
	const base = `${daprEndpoint()}/v1.0/invoke/${encodedApp}/method/api/v2/agent-runs/${encodedInstance}`;
	const url =
		operation === "terminate"
			? `${base}/terminate`
			: `${base}?force=${args.force ? "true" : "false"}&recursive=true`;
	const init: RequestInit =
		operation === "terminate"
			? {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ reason: args.reason }),
				}
			: { method: "DELETE" };
	const res = await fetch(url, init);
	if (res.ok || res.status === 404) return;
	const detail = await res.text().catch(() => "");
	throw new Error(
		`${operation} ${runtimeAppId}/${instanceId} failed: ${res.status} ${detail.slice(0, 500)}`,
	);
}

async function agentRunStatus(
	runtimeAppId: string,
	instanceId: string,
): Promise<string | null> {
	const encodedApp = encodeURIComponent(runtimeAppId);
	const encodedInstance = encodeURIComponent(instanceId);
	const url = `${daprEndpoint()}/v1.0/invoke/${encodedApp}/method/api/v2/agent-runs/${encodedInstance}/status?summary=true`;
	const res = await fetch(url);
	if (res.status === 404) return null;
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`status ${runtimeAppId}/${instanceId} failed: ${res.status} ${detail.slice(0, 500)}`,
		);
	}
	const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
	const status = body?.runtimeStatus ?? body?.status ?? body?.phase;
	return typeof status === "string" ? status.toUpperCase() : "UNKNOWN";
}

function isTerminalStatus(status: string | null): boolean {
	return (
		status === null ||
		status === "COMPLETED" ||
		status === "FAILED" ||
		status === "CANCELED" ||
		status === "CANCELLED" ||
		status === "TERMINATED"
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTerminalOrMissing(
	runtimeAppId: string,
	instanceId: string,
	args: Args,
): Promise<string | null> {
	const deadline = Date.now() + args.terminateWaitSeconds * 1000;
	let lastStatus: string | null = "UNKNOWN";
	while (true) {
		lastStatus = await agentRunStatus(runtimeAppId, instanceId);
		if (isTerminalStatus(lastStatus)) return lastStatus;
		if (Date.now() >= deadline) return lastStatus;
		await sleep(1000);
	}
}

async function markSessionsTerminated(
	sql: postgres.Sql,
	targets: CleanupTarget[],
	args: Args,
) {
	if (targets.length === 0) return;
	const now = new Date();
	const stopReason = {
		type: "cutover_purge",
		reason: args.reason,
		cutover: "session-native-dapr-agent-loop",
		at: now.toISOString(),
	};
	const ids = targets.map((target) => target.session.id);
	await sql`
		UPDATE sessions
		SET
			status = 'terminated',
			stop_reason = ${sql.json(stopReason)}::jsonb,
			completed_at = COALESCE(completed_at, NOW()),
			updated_at = NOW()
		WHERE id IN ${sql(ids)}
			AND status <> 'terminated'
	`;
}

async function deleteStateRows(
	sql: postgres.Sql,
	targets: CleanupTarget[],
	args: Args,
): Promise<number> {
	const keys = targets.flatMap((target) => target.stateDeleteKeys);
	if (keys.length === 0) return 0;
	const table = sql(args.stateTable);
	const result = await sql`
		DELETE FROM ${table}
		WHERE key IN ${sql(keys)}
	`;
	return result.count;
}

function restartRuntimes(targets: CleanupTarget[], namespace: string) {
	const runtimeAppIds = [
		...new Set(targets.map((target) => target.runtimeAppId).filter(Boolean)),
	].sort();
	for (const runtimeAppId of runtimeAppIds) {
		const result = spawnSync(
			"kubectl",
			["rollout", "restart", `deployment/${runtimeAppId}`, "-n", namespace],
			{ encoding: "utf8" },
		);
		if (result.status !== 0) {
			throw new Error(
				`kubectl rollout restart deployment/${runtimeAppId} failed: ${
					result.stderr || result.stdout
				}`.trim(),
			);
		}
		console.log(`restarted deployment/${runtimeAppId} in ${namespace}`);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	const sql = postgres(databaseUrl, { max: 1 });
	try {
		await assertNoActiveBenchmarks(sql, args.force);
		const sessionRows = await loadSessions(sql, args);
		const eventRows = await loadSessionEvents(
			sql,
			sessionRows.map((session) => session.id),
		);
		const targets = buildTargets(sessionRows, eventRows, args);

		const workflowCount = targets.reduce(
			(total, target) => total + target.instanceIds.length,
			0,
		);
		const stateKeyCount = targets.reduce(
			(total, target) => total + target.stateDeleteKeys.length,
			0,
		);
		console.log(
			`${args.apply ? "APPLY" : "DRY RUN"} session-native cutover: sessions=${targets.length} workflowInstances=${workflowCount} runtimeContextRows=${stateKeyCount}`,
		);
		for (const target of targets) {
			console.log(
				[
					`session=${target.session.id}`,
					`status=${target.session.status}`,
					`runtime=${target.runtimeAppId}`,
					`workflowExecution=${target.session.workflowExecutionId ?? "-"}`,
					`instances=${target.instanceIds.join(",")}`,
					`stateKeys=${target.stateDeleteKeys.length}`,
				].join(" "),
			);
		}

		if (!args.apply || targets.length === 0) return;

		if (!args.skipDapr) {
			for (const target of targets) {
				for (const instanceId of target.instanceIds) {
					await invokeDapr(target.runtimeAppId, instanceId, "terminate", args);
					const status = await waitForTerminalOrMissing(
						target.runtimeAppId,
						instanceId,
						args,
					);
					if (!isTerminalStatus(status) && !args.force) {
						throw new Error(
							`${target.runtimeAppId}/${instanceId} did not become terminal before purge; last status=${status}. Re-run with --force only if this cutover intentionally discards the active workflow.`,
						);
					}
					await invokeDapr(target.runtimeAppId, instanceId, "purge", args);
					console.log(`purged ${target.runtimeAppId}/${instanceId}`);
				}
			}
		}

		await markSessionsTerminated(sql, targets, args);

		let deletedStateRows = 0;
		if (!args.skipStateDelete) {
			deletedStateRows = await deleteStateRows(sql, targets, args);
		}

		if (args.restartRuntimes) restartRuntimes(targets, args.namespace);

		console.log(
			`complete sessions=${targets.length} stateRowsDeleted=${deletedStateRows}`,
		);
	} finally {
		await sql.end({ timeout: 5 });
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
