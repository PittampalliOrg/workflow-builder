type DurationStats = {
	count: number;
	total: number | null;
	p50: number | null;
	p90: number | null;
	max: number | null;
};

export type TimingPatch = Record<string, unknown>;

export type BenchmarkTimingSessionEvent = {
	type: string;
	data: unknown;
	createdAt: Date;
};

export type BenchmarkTimingWorkflowLog = {
	nodeId: string;
	duration: unknown;
	startedAt: Date | null;
	completedAt: Date | null;
	output: unknown;
};

export type BenchmarkTimingRunInstance = {
	startedAt: Date | null;
	inferenceCompletedAt: Date | null;
};

export type BenchmarkTimingWorkflowExecution = {
	startedAt: Date | null;
	completedAt: Date | null;
	duration: unknown;
};

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

function logDurationMs(
	log: Pick<BenchmarkTimingWorkflowLog, "duration" | "startedAt" | "completedAt">,
): number | null {
	const direct = durationMs(log.duration);
	if (direct != null) return direct;
	if (log.startedAt && log.completedAt) {
		const elapsed = log.completedAt.getTime() - log.startedAt.getTime();
		return elapsed >= 0 ? elapsed : null;
	}
	return null;
}

function findSandboxReadiness(
	value: unknown,
	depth = 0,
): Record<string, unknown> | null {
	if (!isRecord(value) || depth > 5) return null;
	if (isRecord(value.sandboxReadiness)) return value.sandboxReadiness;
	const workspaceProfile = value.workspaceProfile;
	if (isRecord(workspaceProfile) && isRecord(workspaceProfile.sandboxReadiness)) {
		return workspaceProfile.sandboxReadiness;
	}
	const sandbox = value.sandbox;
	const details = isRecord(sandbox) ? sandbox.details : null;
	if (isRecord(details) && isRecord(details.readiness)) return details.readiness;
	for (const key of ["data", "result", "output", "value"]) {
		const nested = findSandboxReadiness(value[key], depth + 1);
		if (nested) return nested;
	}
	return null;
}

function addSandboxReadinessTiming(
	patch: TimingPatch,
	readiness: Record<string, unknown>,
): void {
	patch.sandbox_readiness = readiness;
	const phases = isRecord(readiness.phaseDurationsMs)
		? readiness.phaseDurationsMs
		: {};
	for (const [phase, value] of Object.entries(phases)) {
		const ms = durationMs(value);
		if (ms == null) continue;
		const key = phase
			.replace(/[^a-zA-Z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.toLowerCase();
		if (key) patch[`sandbox_readiness_${key}_ms`] = ms;
	}
	const snapshot = isRecord(readiness.lastSnapshot) ? readiness.lastSnapshot : null;
	if (snapshot) {
		for (const [source, target] of [
			["sandboxPhase", "sandbox_readiness_sandbox_phase"],
			["podPhase", "sandbox_readiness_pod_phase"],
			["nodeName", "sandbox_readiness_node"],
			["podName", "sandbox_readiness_pod_name"],
		] as const) {
			const value = snapshot[source];
			if (typeof value === "string" && value.trim()) patch[target] = value;
		}
	}
	if (typeof readiness.error === "string" && readiness.error.trim()) {
		patch.sandbox_readiness_error = readiness.error.trim().slice(0, 1000);
	}
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

function eventData(
	event: Pick<BenchmarkTimingSessionEvent, "data">,
): Record<string, unknown> {
	return isRecord(event.data) ? event.data : {};
}

function sessionEventDuration(
	event: Pick<BenchmarkTimingSessionEvent, "data">,
): number | null {
	const data = eventData(event);
	return durationMs(data.duration_ms ?? data.durationMs);
}

export function buildSessionTimingPatchForTest(
	events: BenchmarkTimingSessionEvent[],
	options: { finalize?: boolean; now?: Date } = {},
): TimingPatch {
	return buildSessionTimingPatch(events, options);
}

export function buildSessionTimingPatch(
	events: BenchmarkTimingSessionEvent[],
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
	const firstToolScheduled = ordered.find(
		(event) => event.type === "tool_activity.scheduled",
	);
	const firstToolStarted = firstToolScheduled
		? ordered.find(
				(event) =>
					event.type === "tool_activity.started" &&
					event.createdAt >= firstToolScheduled.createdAt,
			)
		: null;

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
	if (firstToolScheduled) {
		patch.first_tool_scheduled_at = firstToolScheduled.createdAt.toISOString();
		if (firstToolStarted) {
			patch.first_tool_started_at = firstToolStarted.createdAt.toISOString();
			patch.first_tool_scheduled_to_started_ms = elapsedMs(
				firstToolScheduled.createdAt,
				firstToolStarted.createdAt,
			);
			patch.first_tool_scheduled_without_started = false;
		} else {
			const observedUntil = latestEvent?.createdAt ?? options.now ?? new Date();
			patch.first_tool_scheduled_without_started = true;
			patch.first_tool_scheduled_without_started_ms = elapsedMs(
				firstToolScheduled.createdAt,
				observedUntil,
			);
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
		runInstance?: BenchmarkTimingRunInstance | null;
		execution?: BenchmarkTimingWorkflowExecution | null;
		logs: BenchmarkTimingWorkflowLog[];
	},
): TimingPatch {
	return buildWorkflowTimingPatch(input);
}

export function buildWorkflowTimingPatch(input: {
	runInstance?: BenchmarkTimingRunInstance | null;
	execution?: BenchmarkTimingWorkflowExecution | null;
	logs: BenchmarkTimingWorkflowLog[];
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
		if (log.nodeId === "workspace_profile") {
			const readiness = findSandboxReadiness(log.output);
			if (readiness) addSandboxReadinessTiming(patch, readiness);
		}
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
