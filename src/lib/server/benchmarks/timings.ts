import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRunInstances,
	sessionEvents,
	workflowExecutionLogs,
	workflowExecutions,
	type BenchmarkRunInstance,
	type SessionEvent,
	type WorkflowExecutionLog,
} from "$lib/server/db/schema";

type DurationStats = {
	count: number;
	total: number | null;
	p50: number | null;
	p90: number | null;
	max: number | null;
};

type TimingPatch = Record<string, number | string | boolean | null>;

const TIMING_INSTRUMENTATION_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseFloat(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function durationMs(value: unknown): number | null {
	const parsed = finiteNumber(value);
	if (parsed == null || parsed < 0) return null;
	return Math.round(parsed);
}

function logDurationMs(log: Pick<WorkflowExecutionLog, "duration" | "startedAt" | "completedAt">): number | null {
	const direct = durationMs(log.duration);
	if (direct != null) return direct;
	if (log.startedAt && log.completedAt) {
		const elapsed = log.completedAt.getTime() - log.startedAt.getTime();
		return elapsed >= 0 ? elapsed : null;
	}
	return null;
}

function elapsedMs(start?: Date | null, end?: Date | null): number | null {
	if (!start || !end) return null;
	const elapsed = end.getTime() - start.getTime();
	return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function percentile(sorted: number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
	return sorted[idx];
}

function durationStats(values: Array<number | null | undefined>): DurationStats {
	const sorted = values
		.filter(
			(value): value is number =>
				typeof value === "number" && Number.isFinite(value) && value >= 0,
		)
		.sort((a, b) => a - b);
	return {
		count: sorted.length,
		total: sorted.length > 0 ? sorted.reduce((sum, value) => sum + value, 0) : null,
		p50: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		max: sorted.length > 0 ? sorted[sorted.length - 1] : null,
	};
}

function addStats(
	patch: TimingPatch,
	prefix: string,
	stats: DurationStats,
): void {
	if (stats.count === 0) return;
	patch[`${prefix}_count`] = stats.count;
	patch[`${prefix}_duration_ms`] = stats.total;
	patch[`${prefix}_duration_p50_ms`] = stats.p50;
	patch[`${prefix}_duration_p90_ms`] = stats.p90;
	patch[`${prefix}_duration_max_ms`] = stats.max;
}

function eventData(event: Pick<SessionEvent, "data">): Record<string, unknown> {
	return isRecord(event.data) ? event.data : {};
}

function sessionEventDuration(event: Pick<SessionEvent, "data">): number | null {
	const data = eventData(event);
	return durationMs(data.duration_ms ?? data.durationMs);
}

export function buildSessionTimingPatchForTest(
	events: Array<Pick<SessionEvent, "type" | "data" | "createdAt">>,
	options: { finalize?: boolean; now?: Date } = {},
): TimingPatch {
	return buildSessionTimingPatch(events, options);
}

function buildSessionTimingPatch(
	events: Array<Pick<SessionEvent, "type" | "data" | "createdAt">>,
	options: { finalize?: boolean; now?: Date } = {},
): TimingPatch {
	const ordered = [...events].sort(
		(a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
	);
	const patch: TimingPatch = {
		instrumentation_version: TIMING_INSTRUMENTATION_VERSION,
	};
	const modelStats = durationStats(
		ordered
			.filter((event) => event.type === "agent.llm_usage")
			.map(sessionEventDuration),
	);
	const toolStats = durationStats(
		ordered
			.filter((event) => event.type === "agent.tool_result")
			.map(sessionEventDuration),
	);
	addStats(patch, "llm", modelStats);
	addStats(patch, "tool", toolStats);

	const turnStart = ordered.find((event) => event.type === "session.turn_started");
	const terminal = [...ordered]
		.reverse()
		.find((event) =>
			event.type === "session.status_terminated" ||
			event.type === "session.status_errored",
		);
	const latestEvent = ordered[ordered.length - 1] ?? null;
	const heartbeat = [...ordered]
		.reverse()
		.find((event) => event.type === "session.turn_heartbeat");

	if (turnStart) {
		patch.turn_started_at = turnStart.createdAt.toISOString();
		const turnEnd = terminal?.createdAt ?? (options.finalize ? latestEvent?.createdAt : null);
		const completedElapsed = elapsedMs(turnStart.createdAt, turnEnd);
		if (completedElapsed != null) {
			patch.turn_completed_at = turnEnd?.toISOString() ?? null;
			patch.turn_duration_ms = completedElapsed;
			patch.active_turn_elapsed_ms = null;
		} else {
			const activeElapsed = elapsedMs(
				turnStart.createdAt,
				latestEvent?.createdAt ?? options.now ?? new Date(),
			);
			if (activeElapsed != null) patch.active_turn_elapsed_ms = activeElapsed;
		}
	}
	if (heartbeat) {
		const data = eventData(heartbeat);
		const elapsedSeconds = finiteNumber(data.elapsed_seconds ?? data.elapsedSeconds);
		if (elapsedSeconds != null && elapsedSeconds >= 0) {
			patch.latest_turn_heartbeat_seconds = Math.round(elapsedSeconds);
		}
	}
	if (latestEvent) {
		patch.last_session_event_at = latestEvent.createdAt.toISOString();
		patch.last_session_event_type = latestEvent.type;
	}
	return patch;
}

export function buildWorkflowTimingPatchForTest(
	input: {
		runInstance?: Pick<BenchmarkRunInstance, "startedAt" | "inferenceCompletedAt"> | null;
		execution?: Pick<typeof workflowExecutions.$inferSelect, "startedAt" | "completedAt" | "duration"> | null;
		logs: Array<Pick<WorkflowExecutionLog, "nodeId" | "duration" | "startedAt" | "completedAt">>;
	},
): TimingPatch {
	return buildWorkflowTimingPatch(input);
}

function buildWorkflowTimingPatch(input: {
	runInstance?: Pick<BenchmarkRunInstance, "startedAt" | "inferenceCompletedAt"> | null;
	execution?: Pick<typeof workflowExecutions.$inferSelect, "startedAt" | "completedAt" | "duration"> | null;
	logs: Array<Pick<WorkflowExecutionLog, "nodeId" | "duration" | "startedAt" | "completedAt">>;
}): TimingPatch {
	const patch: TimingPatch = {
		instrumentation_version: TIMING_INSTRUMENTATION_VERSION,
	};
	const inferenceDuration = elapsedMs(
		input.runInstance?.startedAt,
		input.runInstance?.inferenceCompletedAt,
	);
	if (inferenceDuration != null) patch.inference_duration_ms = inferenceDuration;

	const workflowDuration =
		durationMs(input.execution?.duration) ??
		elapsedMs(input.execution?.startedAt, input.execution?.completedAt);
	if (workflowDuration != null) patch.workflow_duration_ms = workflowDuration;

	const byNode = new Map<string, number>();
	for (const log of input.logs) {
		const duration = logDurationMs(log);
		if (duration == null) continue;
		const existing = byNode.get(log.nodeId);
		byNode.set(log.nodeId, existing == null ? duration : existing + duration);
	}
	if (byNode.size > 0) patch.workflow_logged_step_count = byNode.size;
	const mappings: Array<[string, string[]]> = [
		["workspace_profile", ["workspace_profile_duration_ms", "sandbox_startup_ms"]],
		["checkout_repo", ["checkout_repo_duration_ms", "repo_checkout_ms"]],
		["solve", ["solve_duration_ms", "agent_solve_ms"]],
		["extract_patch", ["extract_patch_duration_ms", "patch_extraction_ms"]],
		["cleanup_workspace", ["cleanup_workspace_duration_ms", "cleanup_ms"]],
	];
	for (const [nodeId, keys] of mappings) {
		const value = byNode.get(nodeId);
		if (value == null) continue;
		for (const key of keys) patch[key] = value;
	}
	return patch;
}

async function mergeTimingPatchForRunInstance(
	runInstanceId: string,
	patch: TimingPatch,
): Promise<void> {
	const clean = Object.fromEntries(
		Object.entries(patch).filter(([, value]) => value !== undefined),
	);
	if (Object.keys(clean).length === 0) return;
	await db?.execute(sql`
		UPDATE benchmark_run_instances
		SET timings = COALESCE(timings, '{}'::jsonb) || ${JSON.stringify(clean)}::jsonb,
			updated_at = NOW()
		WHERE id = ${runInstanceId}
	`);
}

export async function aggregateBenchmarkSessionTimings(
	sessionId: string,
	options: { finalize?: boolean } = {},
): Promise<void> {
	if (!db || !sessionId) return;
	const [row] = await db
		.select({ id: benchmarkRunInstances.id })
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.sessionId, sessionId))
		.limit(1);
	if (!row) return;
	const events = await db
		.select({
			type: sessionEvents.type,
			data: sessionEvents.data,
			createdAt: sessionEvents.createdAt,
		})
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				inArray(sessionEvents.type, [
					"agent.llm_usage",
					"agent.tool_result",
					"session.turn_started",
					"session.turn_heartbeat",
					"session.status_terminated",
					"session.status_errored",
				]),
			),
		)
		.orderBy(asc(sessionEvents.createdAt));
	await mergeTimingPatchForRunInstance(
		row.id,
		buildSessionTimingPatch(events, options),
	);
}

export async function aggregateBenchmarkInstanceTimings(
	runInstanceId: string,
): Promise<void> {
	if (!db || !runInstanceId) return;
	const [row] = await db
		.select()
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.id, runInstanceId))
		.limit(1);
	if (!row) return;

	const patch: TimingPatch = {};
	if (row.sessionId) {
		const events = await db
			.select({
				type: sessionEvents.type,
				data: sessionEvents.data,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, row.sessionId),
					inArray(sessionEvents.type, [
						"agent.llm_usage",
						"agent.tool_result",
						"session.turn_started",
						"session.turn_heartbeat",
						"session.status_terminated",
						"session.status_errored",
					]),
				),
			)
			.orderBy(asc(sessionEvents.createdAt));
		Object.assign(
			patch,
			buildSessionTimingPatch(events, {
				finalize: row.inferenceCompletedAt != null,
			}),
		);
	}
	if (row.workflowExecutionId) {
		const [execution] = await db
			.select({
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, row.workflowExecutionId))
			.limit(1);
		const logs = await db
			.select({
				nodeId: workflowExecutionLogs.nodeId,
				duration: workflowExecutionLogs.duration,
				startedAt: workflowExecutionLogs.startedAt,
				completedAt: workflowExecutionLogs.completedAt,
			})
			.from(workflowExecutionLogs)
			.where(eq(workflowExecutionLogs.executionId, row.workflowExecutionId))
			.orderBy(asc(workflowExecutionLogs.startedAt));
		Object.assign(
			patch,
			buildWorkflowTimingPatch({
				runInstance: row,
				execution,
				logs,
			}),
		);
	} else {
		Object.assign(
			patch,
			buildWorkflowTimingPatch({
				runInstance: row,
				execution: null,
				logs: [],
			}),
		);
	}
	await mergeTimingPatchForRunInstance(row.id, patch);
}
