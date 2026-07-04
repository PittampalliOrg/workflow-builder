/**
 * Pure benchmark domain logic, extracted from the quarantine adapter
 * (`adapters/benchmark-service.ts`) — hex P3 slice 1.
 *
 * Everything in this module is side-effect-free: no DB, no Dapr, no
 * Kubernetes, no fetch, no env reads. Configuration values (stall
 * thresholds, retry limits) are read by the adapter and injected here as
 * plain arguments; hashing via node:crypto is deterministic.
 */
import { createHash } from "node:crypto";
import type { BenchmarkRunStatus } from "$lib/server/benchmarks/swebench";

export type BenchmarkRunTerminalOutcome = Extract<
	BenchmarkRunStatus,
	"failed" | "cancelled"
>;

export type BenchmarkAgentRuntimeCleanupInput = {
	runtimeAppId: string | null;
	sessionId: string | null;
	turnCount: number | null;
};

export type BenchmarkSessionTurnInput = {
	sessionId: string;
	childInstanceId: string | null;
	turn: number | null;
	agentWorkflowMode?: string | null;
};

// --- agent-runtime cleanup app-id helpers -----------------------------------

export function benchmarkAgentRuntimeCleanupInstanceIds(
	row: BenchmarkAgentRuntimeCleanupInput,
	turns?: BenchmarkSessionTurnInput | BenchmarkSessionTurnInput[] | null,
): string[] {
	const sessionId = row.sessionId?.trim();
	if (!row.runtimeAppId || !sessionId) return [];
	const ids = new Set<string>([sessionId]);
	const knownTurns = Array.isArray(turns) ? turns : turns ? [turns] : [];
	for (const turn of knownTurns) {
		const child = turn.childInstanceId?.trim();
		if (child && child !== sessionId) ids.add(child);
	}
	return [...ids];
}

export function benchmarkSessionHostAppId(sessionId: string): string | null {
	const normalized = sessionId.trim();
	if (!normalized) return null;
	const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 20);
	return `agent-session-${digest}`;
}

// --- terminal-reason shapers -------------------------------------------------

export function benchmarkRunTerminalReason(
	status: BenchmarkRunTerminalOutcome,
	extra: Record<string, unknown>,
): string {
	const error = typeof extra.error === "string" ? extra.error.trim() : "";
	if (error) return error;
	return status === "cancelled" ? "benchmark run cancelled" : "benchmark run failed";
}

export function benchmarkRunInstanceTerminalReason(
	existingReason: string | null,
	terminalReason: string,
): string {
	if (!existingReason || existingReason === "end_turn") return terminalReason;
	return existingReason;
}

export function benchmarkSuccessfulEmptyPatchTerminationReason(
	existingReason: string | null,
	agentStopReason: string | null,
): string | null {
	if (!agentStopReason) return existingReason;
	if (!existingReason || existingReason === "end_turn") {
		return "max_turns_without_patch";
	}
	return existingReason;
}

// --- inference stall detection -----------------------------------------------

export function benchmarkInferenceStallRetryCount(
	terminationReason?: string | null,
): number {
	const match = String(terminationReason ?? "").match(
		/^no_session_progress_retry_(\d+)$/,
	);
	if (!match) return 0;
	const parsed = Number.parseInt(match[1] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function isRetryableBenchmarkInferenceFailure(
	terminationReason?: string | null,
): boolean {
	const reason = terminationReason?.trim();
	return (
		reason === "session_host_nonterminal_timeout" ||
		reason === "no_session_progress"
	);
}

export const BENCHMARK_INFERENCE_PROGRESS_EVENT_TYPES = [
	"session.turn_started",
	"agent.iteration",
	"llm_start",
	"agent.llm_usage",
	"agent.message",
	"agent.tool_use",
	"agent.tool_result",
] as const;

export function benchmarkInstanceProgressEventTypesForSession(
	sessionStatus?: string | null,
): readonly string[] {
	if (sessionStatus === "rescheduling") {
		return BENCHMARK_INFERENCE_PROGRESS_EVENT_TYPES;
	}
	return [
		...BENCHMARK_INFERENCE_PROGRESS_EVENT_TYPES,
		"user.message",
	] as const;
}

export function latestBenchmarkInferenceProgressAt(input: {
	startedAt?: Date | null;
	latestProgressEventCreatedAt?: Date | null;
	latestHeartbeatAt?: Date | null;
}): Date | null {
	const timestamps = [
		input.startedAt,
		input.latestProgressEventCreatedAt,
	].filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
	if (timestamps.length === 0) return null;
	return timestamps.reduce((latest, value) =>
		value.getTime() > latest.getTime() ? value : latest,
	);
}

export function benchmarkInferenceStallState(input: {
	now: Date;
	stallSeconds: number;
	startedAt?: Date | null;
	latestProgressEventCreatedAt?: Date | null;
	latestHeartbeatAt?: Date | null;
}): { stalled: boolean; lastProgressAt: Date | null; stalledSeconds: number } {
	const lastProgressAt = latestBenchmarkInferenceProgressAt(input);
	if (!lastProgressAt) {
		return { stalled: false, lastProgressAt: null, stalledSeconds: 0 };
	}
	const stalledSeconds = Math.max(
		0,
		Math.floor((input.now.getTime() - lastProgressAt.getTime()) / 1000),
	);
	return {
		stalled: stalledSeconds >= input.stallSeconds,
		lastProgressAt,
		stalledSeconds,
	};
}
