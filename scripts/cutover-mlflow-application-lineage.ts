/**
 * Full MLflow application-layout cutover.
 *
 * Usage:
 *   node scripts/cutover-mlflow-application-lineage.bundle.js --dry-run
 *   node scripts/cutover-mlflow-application-lineage.bundle.js --apply
 *   node scripts/cutover-mlflow-application-lineage.bundle.js --apply --agent=kimi-k26-swebench-canary
 */

import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../src/lib/server/db";
import {
	agents,
	agentVersions,
	benchmarkRunInstances,
	benchmarkRuns,
	sessions,
	workflowExecutions,
} from "../src/lib/server/db/schema";
import {
	createInteractiveSessionMlflowRun,
	registerAgentVersionInMlflow,
} from "../src/lib/server/observability/mlflow-lifecycle";
import {
	ensureBenchmarkInstanceMlflowRun,
	ensureBenchmarkMlflowRun,
} from "../src/lib/server/benchmarks/mlflow";

type Args = {
	apply: boolean;
	agentFilter: string | null;
	sessionFilter: string | null;
	limit: number | null;
};

function parseArgs(argv: string[]): Args {
	let apply = false;
	let agentFilter: string | null = null;
	let sessionFilter: string | null = null;
	let limit: number | null = null;
	for (const arg of argv.slice(2)) {
		if (arg === "--apply") apply = true;
		else if (arg === "--dry-run") apply = false;
		else if (arg.startsWith("--agent=")) agentFilter = arg.slice("--agent=".length);
		else if (arg.startsWith("--session=")) sessionFilter = arg.slice("--session=".length);
		else if (arg.startsWith("--limit=")) {
			const parsed = Number(arg.slice("--limit=".length));
			if (Number.isInteger(parsed) && parsed > 0) limit = parsed;
		}
	}
	return { apply, agentFilter, sessionFilter, limit };
}

function modelIdFromMlflowUri(value: string | null | undefined): string | null {
	const text = value?.trim() ?? "";
	const match = text.match(/^models:\/([^/]+)$/);
	return match?.[1] ?? null;
}

function normalizeMlflowTraceId(value: string | null | undefined): string | null {
	const raw = value?.trim().toLowerCase() ?? "";
	if (!raw) return null;
	const normalized = raw.startsWith("tr-") ? raw.slice(3) : raw;
	if (!/^[a-f0-9]{32}$/.test(normalized) || /^0+$/.test(normalized)) return null;
	return `tr-${normalized}`;
}

function escapeMlflowFilterValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function mlflowRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
	const base = (process.env.MLFLOW_TRACKING_URI ?? "").trim().replace(/\/+$/, "");
	if (!base) throw new Error("MLFLOW_TRACKING_URI is required");
	const res = await fetch(`${base}${path}`, {
		...init,
		headers: {
			...(init.method && init.method !== "GET" ? { "Content-Type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`MLflow ${path} returned ${res.status}: ${text.slice(0, 300)}`);
	}
	return (await res.json().catch(() => ({}))) as T;
}

function traceIdFromSearchItem(item: unknown): string | null {
	const obj = item as Record<string, unknown>;
	const info =
		(obj.trace_info as Record<string, unknown> | undefined) ??
		(obj.info as Record<string, unknown> | undefined) ??
		obj;
	const raw = info.trace_id ?? info.traceId ?? obj.trace_id ?? obj.traceId;
	return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function traceStateFromSearchItem(item: unknown): "OK" | "ERROR" | null {
	const obj = item as Record<string, unknown>;
	const info =
		(obj.trace_info as Record<string, unknown> | undefined) ??
		(obj.info as Record<string, unknown> | undefined) ??
		obj;
	const raw = info.state ?? info.status;
	if (raw === "OK" || raw === "ERROR") return raw;
	return null;
}

function traceEndTimestampMsFromSearchItem(item: unknown): number {
	const obj = item as Record<string, unknown>;
	const info =
		(obj.trace_info as Record<string, unknown> | undefined) ??
		(obj.info as Record<string, unknown> | undefined) ??
		obj;
	const startMs =
		typeof info.timestamp_ms === "number"
			? info.timestamp_ms
			: typeof info.request_time === "string"
				? Date.parse(info.request_time)
				: NaN;
	const durationText = typeof info.execution_duration === "string" ? info.execution_duration : "";
	const seconds = Number(durationText.replace(/s$/, ""));
	if (Number.isFinite(startMs) && Number.isFinite(seconds)) {
		return Math.round(startMs + seconds * 1000);
	}
	return Date.now();
}

async function patchInteractiveSessionTraces(params: {
	sessionId: string;
	traceExperimentId: string | null | undefined;
	runId: string | null | undefined;
	modelId: string | null | undefined;
	apply: boolean;
}): Promise<number> {
	const experimentId = params.traceExperimentId?.trim();
	if (!experimentId) return 0;
	const matches: unknown[] = [];
	let pageToken: string | undefined;
	const filter = `metadata.\`mlflow.trace.session\` LIKE '%${escapeMlflowFilterValue(params.sessionId)}%'`;
	for (let page = 0; page < 20; page++) {
		const payload = await mlflowRequest<{
			traces?: unknown[];
			next_page_token?: string;
		}>("/api/3.0/mlflow/traces/search", {
			method: "POST",
			body: JSON.stringify({
				locations: [
					{
						type: "MLFLOW_EXPERIMENT",
						mlflow_experiment: { experiment_id: experimentId },
					},
				],
				filter,
				max_results: 250,
				order_by: ["timestamp_ms DESC"],
				...(pageToken ? { page_token: pageToken } : {}),
			}),
		});
		const sessionNeedle = params.sessionId;
		const turnNeedle = `${params.sessionId}:turn-`;
		matches.push(
			...(payload.traces ?? []).filter((item) => {
				const text = JSON.stringify(item);
				return text.includes(turnNeedle) || text.includes(`"session.id":"${sessionNeedle}"`);
			}),
		);
		pageToken = payload.next_page_token;
		if (!pageToken) break;
	}
	if (!params.apply) return matches.length;
	let patched = 0;
	for (const item of matches) {
		const traceId = traceIdFromSearchItem(item);
		if (!traceId) continue;
		const status = traceStateFromSearchItem(item);
		if (!status) {
			console.warn(`${traceId}: trace patch skipped non-terminal trace state`);
			continue;
		}
		try {
			await mlflowRequest(`/api/2.0/mlflow/traces/${encodeURIComponent(traceId)}`, {
				method: "PATCH",
				body: JSON.stringify({
					timestamp_ms: traceEndTimestampMsFromSearchItem(item),
					status,
					request_metadata: [
						{ key: "mlflow.trace.session", value: params.sessionId },
						...(params.runId ? [{ key: "mlflow.sourceRun", value: params.runId }] : []),
						...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
					],
					tags: [
						{ key: "session.id", value: params.sessionId },
						{ key: "agent.session.id", value: params.sessionId },
						{ key: "workflow_builder.session_id", value: params.sessionId },
						{ key: "workflow_builder.mlflow_session_id", value: params.sessionId },
						...(params.runId ? [{ key: "mlflow.run_id", value: params.runId }] : []),
						...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
					],
				}),
			});
			patched++;
		} catch (err) {
			console.warn(
				`${traceId}: trace patch skipped ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return patched;
}

async function findTraceByRequestId(params: {
	traceExperimentId: string | null | undefined;
	traceId: string | null | undefined;
}): Promise<unknown | null> {
	const experimentId = params.traceExperimentId?.trim();
	const traceId = normalizeMlflowTraceId(params.traceId);
	if (!experimentId || !traceId) return null;
	const filters = [
		`request_id = '${escapeMlflowFilterValue(traceId)}'`,
		`trace.request_id = '${escapeMlflowFilterValue(traceId)}'`,
	];
	for (const filter of filters) {
		try {
			const payload = await mlflowRequest<{
				traces?: unknown[];
			}>("/api/3.0/mlflow/traces/search", {
				method: "POST",
				body: JSON.stringify({
					locations: [
						{
							type: "MLFLOW_EXPERIMENT",
							mlflow_experiment: { experiment_id: experimentId },
						},
					],
					filter,
					max_results: 1,
					order_by: ["timestamp_ms DESC"],
				}),
			});
			const match = payload.traces?.[0] ?? null;
			if (match) return match;
		} catch (err) {
			console.warn(
				`${traceId}: trace search filter ${filter} skipped ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return null;
}

async function patchTraceRunAndModel(params: {
	traceExperimentId: string | null | undefined;
	traceId: string | null | undefined;
	sessionId?: string | null;
	runId: string | null | undefined;
	modelId: string | null | undefined;
	apply: boolean;
}): Promise<boolean> {
	const traceId = normalizeMlflowTraceId(params.traceId);
	if (!traceId) return false;
	const item = await findTraceByRequestId({
		traceExperimentId: params.traceExperimentId,
		traceId,
	});
	if (!item) return false;
	if (!params.apply) return true;
	const status = traceStateFromSearchItem(item);
	if (!status) {
		console.warn(`${traceId}: trace patch skipped non-terminal trace state`);
		return false;
	}
	await mlflowRequest(`/api/2.0/mlflow/traces/${encodeURIComponent(traceId)}`, {
		method: "PATCH",
		body: JSON.stringify({
			timestamp_ms: traceEndTimestampMsFromSearchItem(item),
			status,
			request_metadata: [
				...(params.sessionId
					? [{ key: "mlflow.trace.session", value: params.sessionId }]
					: []),
				...(params.runId ? [{ key: "mlflow.sourceRun", value: params.runId }] : []),
				...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
			],
			tags: [
				...(params.sessionId
					? [
							{ key: "session.id", value: params.sessionId },
							{ key: "agent.session.id", value: params.sessionId },
							{ key: "workflow_builder.session_id", value: params.sessionId },
						]
					: []),
				...(params.runId ? [{ key: "mlflow.run_id", value: params.runId }] : []),
				...(params.modelId ? [{ key: "mlflow.modelId", value: params.modelId }] : []),
			],
		}),
	});
	return true;
}

async function main() {
	const args = parseArgs(process.argv);
	if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
	if (!process.env.MLFLOW_TRACKING_URI) throw new Error("MLFLOW_TRACKING_URI is required");

	const agentFilter = args.agentFilter
		? or(eq(agents.id, args.agentFilter), eq(agents.slug, args.agentFilter))
		: undefined;
	const agentRowsQuery = db
		.select({ agent: agents, version: agentVersions })
		.from(agents)
		.innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
		.where(
			and(
				eq(agents.isArchived, false),
				isNotNull(agents.currentVersionId),
				eq(agentVersions.id, agents.currentVersionId),
				sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
				agentFilter,
			),
		)
		.orderBy(agents.slug);
	const agentRows = args.limit ? await agentRowsQuery.limit(args.limit) : await agentRowsQuery;

	console.log(`${args.apply ? "APPLY" : "DRY RUN"} - agents=${agentRows.length}`);
	let models = 0;
	let runs = 0;
	let instances = 0;
	let sessionsConverted = 0;
	let tracesPatched = 0;
	let failed = 0;

	for (const row of agentRows) {
		const label = `${row.agent.slug}@v${row.version.version}`;
		if (!args.apply) {
			console.log(`${label}: would republish current version into canonical trace experiment`);
			continue;
		}
		try {
			const registered = await registerAgentVersionInMlflow({
				agent: row.agent,
				version: row.version,
			});
			console.log(`${label}: model=${registered?.modelUri ?? "disabled"}`);
			models++;
		} catch (err) {
			failed++;
			console.error(`${label}: model FAIL ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const runRowsQuery = db
		.select({ id: benchmarkRuns.id })
		.from(benchmarkRuns)
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(agentFilter)
		.orderBy(benchmarkRuns.createdAt);
	const runRows = args.limit ? await runRowsQuery.limit(args.limit) : await runRowsQuery;
	console.log(`${args.apply ? "APPLY" : "DRY RUN"} - benchmark runs=${runRows.length}`);

	for (const row of runRows) {
		if (!args.apply) {
			console.log(`${row.id}: would refresh benchmark parent run`);
			continue;
		}
		try {
			const runId = await ensureBenchmarkMlflowRun(row.id);
			console.log(`${row.id}: run=${runId ?? "disabled"}`);
			runs++;
		} catch (err) {
			failed++;
			console.error(`${row.id}: run FAIL ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const instanceRowsQuery = db
		.select({
			runId: benchmarkRunInstances.runId,
			instanceId: benchmarkRunInstances.instanceId,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(agentFilter)
		.orderBy(benchmarkRunInstances.createdAt);
	const instanceRows = args.limit
		? await instanceRowsQuery.limit(args.limit)
		: await instanceRowsQuery;
	console.log(`${args.apply ? "APPLY" : "DRY RUN"} - benchmark instances=${instanceRows.length}`);

	for (const row of instanceRows) {
		if (!args.apply) {
			console.log(`${row.runId}/${row.instanceId}: would refresh benchmark instance run and patch trace metadata`);
			continue;
		}
		try {
			const runId = await ensureBenchmarkInstanceMlflowRun({
				runId: row.runId,
				instanceId: row.instanceId,
			});
			const [patchedRow] = await db
				.select({
					run: benchmarkRuns,
					runInstance: benchmarkRunInstances,
					primaryTraceId: workflowExecutions.primaryTraceId,
					version: agentVersions,
				})
				.from(benchmarkRunInstances)
				.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
				.leftJoin(
					workflowExecutions,
					eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
				)
				.leftJoin(
					agentVersions,
					and(
						eq(agentVersions.agentId, benchmarkRuns.agentId),
						eq(agentVersions.version, benchmarkRuns.agentVersion),
					),
				)
				.where(
					and(
						eq(benchmarkRunInstances.runId, row.runId),
						eq(benchmarkRunInstances.instanceId, row.instanceId),
					),
				)
				.limit(1);
			const tracePatched = patchedRow
				? await patchTraceRunAndModel({
						traceExperimentId: patchedRow.run.mlflowExperimentId,
						traceId: patchedRow.runInstance.mlflowTraceId ?? patchedRow.primaryTraceId,
						sessionId: patchedRow.runInstance.sessionId,
						runId: patchedRow.runInstance.mlflowRunId ?? runId,
						modelId:
							patchedRow.version?.mlflowModelVersion ??
							modelIdFromMlflowUri(patchedRow.version?.mlflowUri),
						apply: true,
					}).catch((err) => {
						console.warn(
							`${row.runId}/${row.instanceId}: trace patch skipped ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
						return false;
					})
				: false;
			if (tracePatched) tracesPatched++;
			console.log(
				`${row.runId}/${row.instanceId}: run=${runId ?? "disabled"} tracePatched=${tracePatched}`,
			);
			instances++;
		} catch (err) {
			failed++;
			console.error(
				`${row.runId}/${row.instanceId}: instance FAIL ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	const sessionFilter = args.sessionFilter
		? eq(sessions.id, args.sessionFilter)
		: undefined;
	const sessionRowsQuery = db
		.select({ session: sessions, agent: agents, version: agentVersions })
		.from(sessions)
		.innerJoin(agents, eq(agents.id, sessions.agentId))
		.leftJoin(
			agentVersions,
			and(
				eq(agentVersions.agentId, agents.id),
				eq(agentVersions.version, sessions.agentVersion),
			),
		)
		.where(and(agentFilter, sessionFilter, isNull(sessions.workflowExecutionId)))
		.orderBy(sessions.createdAt);
	const sessionRows = args.limit ? await sessionRowsQuery.limit(args.limit) : await sessionRowsQuery;
	console.log(`${args.apply ? "APPLY" : "DRY RUN"} - interactive sessions=${sessionRows.length}`);
	for (const row of sessionRows) {
		const label = `${row.agent.slug}/session/${row.session.id}`;
		if (!args.apply) {
			console.log(`${label}: would create session parent run and patch turn traces`);
			sessionsConverted++;
			continue;
		}
		try {
			const activeModelUri = row.version?.mlflowUri ?? null;
			const ctx = await createInteractiveSessionMlflowRun({
				sessionId: row.session.id,
				title: row.session.title,
				projectId: row.session.projectId,
				userId: row.session.userId,
				agentId: row.agent.id,
				agentName: row.agent.name,
				agentSlug: row.agent.slug,
				agentVersion: row.session.agentVersion,
				agentAppId: row.agent.runtimeAppId,
				activeModelId: row.version?.mlflowModelVersion ?? modelIdFromMlflowUri(activeModelUri),
				activeModelName: row.version?.mlflowModelName ?? null,
				activeModelUri,
				existingRunId: row.session.mlflowRunId,
			});
			const patched = await patchInteractiveSessionTraces({
				sessionId: row.session.id,
				traceExperimentId:
					ctx?.traceExperimentId ?? process.env.MLFLOW_TRACE_EXPERIMENT_ID ?? ctx?.experimentId,
				runId: ctx?.runId ?? row.session.mlflowRunId,
				modelId: ctx?.activeModelId ?? row.version?.mlflowModelVersion ?? modelIdFromMlflowUri(activeModelUri),
				apply: true,
			});
			console.log(`${label}: run=${ctx?.runId ?? "disabled"} tracesPatched=${patched}`);
			sessionsConverted++;
			tracesPatched += patched;
		} catch (err) {
			failed++;
			console.error(`${label}: session FAIL ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	console.log(
		`summary models=${models} runs=${runs} instances=${instances} sessions=${sessionsConverted} tracesPatched=${tracesPatched} failed=${failed}`,
	);
	if (failed > 0) process.exit(1);
}

main()
	.catch((err) => {
		console.error(err);
		process.exit(1);
	})
	.finally(async () => {
		await db.$client?.end?.();
	});
