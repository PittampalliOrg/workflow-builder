import { describe, expect, it } from "vitest";
import {
	BENCHMARK_INFERENCE_PROGRESS_EVENT_TYPES,
	benchmarkAgentRuntimeCleanupInstanceIds,
	benchmarkInferenceStallRetryCount,
	benchmarkInferenceStallState,
	benchmarkInstanceProgressEventTypesForSession,
	benchmarkRunInstanceTerminalReason,
	benchmarkRunTerminalReason,
	benchmarkSessionHostAppId,
	benchmarkSuccessfulEmptyPatchTerminationReason,
	isRetryableBenchmarkInferenceFailure,
	latestBenchmarkInferenceProgressAt,
} from "$lib/server/application/benchmark-logic";

describe("benchmarkInferenceStallState", () => {
	const now = new Date("2026-07-04T12:00:00Z");

	it("reports not stalled when there is no progress signal at all", () => {
		expect(
			benchmarkInferenceStallState({ now, stallSeconds: 60 }),
		).toEqual({ stalled: false, lastProgressAt: null, stalledSeconds: 0 });
	});

	it("stalls once the newest progress timestamp is older than the threshold", () => {
		const startedAt = new Date(now.getTime() - 300_000);
		const state = benchmarkInferenceStallState({
			now,
			stallSeconds: 240,
			startedAt,
		});
		expect(state.stalled).toBe(true);
		expect(state.lastProgressAt).toEqual(startedAt);
		expect(state.stalledSeconds).toBe(300);
	});

	it("uses the NEWEST of startedAt and the latest progress event", () => {
		const startedAt = new Date(now.getTime() - 600_000);
		const latestProgressEventCreatedAt = new Date(now.getTime() - 30_000);
		const state = benchmarkInferenceStallState({
			now,
			stallSeconds: 60,
			startedAt,
			latestProgressEventCreatedAt,
		});
		expect(state.stalled).toBe(false);
		expect(state.lastProgressAt).toEqual(latestProgressEventCreatedAt);
		expect(state.stalledSeconds).toBe(30);
	});

	it("treats exactly-at-threshold as stalled", () => {
		const state = benchmarkInferenceStallState({
			now,
			stallSeconds: 60,
			startedAt: new Date(now.getTime() - 60_000),
		});
		expect(state.stalled).toBe(true);
	});
});

describe("latestBenchmarkInferenceProgressAt", () => {
	it("ignores invalid dates and returns null when nothing is valid", () => {
		expect(
			latestBenchmarkInferenceProgressAt({
				startedAt: new Date(Number.NaN),
				latestProgressEventCreatedAt: null,
			}),
		).toBeNull();
	});
});

describe("benchmarkInferenceStallRetryCount", () => {
	it("parses the retry ordinal out of the termination reason", () => {
		expect(benchmarkInferenceStallRetryCount("no_session_progress_retry_2")).toBe(2);
	});

	it("returns 0 for non-retry reasons, malformed ordinals, and null", () => {
		expect(benchmarkInferenceStallRetryCount("no_session_progress")).toBe(0);
		expect(benchmarkInferenceStallRetryCount("no_session_progress_retry_x")).toBe(0);
		expect(benchmarkInferenceStallRetryCount(null)).toBe(0);
	});
});

describe("isRetryableBenchmarkInferenceFailure", () => {
	it("only stall-shaped termination reasons are retryable", () => {
		expect(isRetryableBenchmarkInferenceFailure("no_session_progress")).toBe(true);
		expect(isRetryableBenchmarkInferenceFailure("session_host_nonterminal_timeout")).toBe(true);
		expect(isRetryableBenchmarkInferenceFailure("end_turn")).toBe(false);
		expect(isRetryableBenchmarkInferenceFailure(null)).toBe(false);
	});
});

describe("benchmarkInstanceProgressEventTypesForSession", () => {
	it("excludes user.message while a session is rescheduling", () => {
		expect(benchmarkInstanceProgressEventTypesForSession("rescheduling")).toEqual(
			BENCHMARK_INFERENCE_PROGRESS_EVENT_TYPES,
		);
	});

	it("counts user.message as progress otherwise", () => {
		expect(benchmarkInstanceProgressEventTypesForSession("running")).toContain("user.message");
	});
});

describe("terminal-reason shapers", () => {
	it("benchmarkRunTerminalReason prefers a concrete error string", () => {
		expect(benchmarkRunTerminalReason("failed", { error: " boom " })).toBe("boom");
		expect(benchmarkRunTerminalReason("cancelled", {})).toBe("benchmark run cancelled");
		expect(benchmarkRunTerminalReason("failed", { error: 42 })).toBe("benchmark run failed");
	});

	it("benchmarkRunInstanceTerminalReason only overwrites empty/end_turn reasons", () => {
		expect(benchmarkRunInstanceTerminalReason(null, "benchmark_run_failed")).toBe(
			"benchmark_run_failed",
		);
		expect(benchmarkRunInstanceTerminalReason("end_turn", "benchmark_run_cancelled")).toBe(
			"benchmark_run_cancelled",
		);
		expect(benchmarkRunInstanceTerminalReason("oom_killed", "benchmark_run_failed")).toBe(
			"oom_killed",
		);
	});

	it("benchmarkSuccessfulEmptyPatchTerminationReason marks empty-patch max-turn stops", () => {
		expect(benchmarkSuccessfulEmptyPatchTerminationReason(null, "max_turns")).toBe(
			"max_turns_without_patch",
		);
		expect(benchmarkSuccessfulEmptyPatchTerminationReason("end_turn", "max_turns")).toBe(
			"max_turns_without_patch",
		);
		expect(benchmarkSuccessfulEmptyPatchTerminationReason("timeout", "max_turns")).toBe(
			"timeout",
		);
		expect(benchmarkSuccessfulEmptyPatchTerminationReason("end_turn", null)).toBe("end_turn");
	});
});

describe("agent-runtime cleanup app-id helpers", () => {
	it("benchmarkSessionHostAppId derives a stable hashed app-id", () => {
		const appId = benchmarkSessionHostAppId("  session-123  ");
		expect(appId).toMatch(/^agent-session-[0-9a-f]{20}$/);
		expect(benchmarkSessionHostAppId("session-123")).toBe(appId);
		expect(benchmarkSessionHostAppId("   ")).toBeNull();
	});

	it("benchmarkAgentRuntimeCleanupInstanceIds dedupes the session id and child instances", () => {
		const ids = benchmarkAgentRuntimeCleanupInstanceIds(
			{ runtimeAppId: "app-1", sessionId: "sess-1", turnCount: 2 },
			[
				{ sessionId: "sess-1", childInstanceId: "sess-1", turn: 1 },
				{ sessionId: "sess-1", childInstanceId: "sess-1__turn__2", turn: 2 },
			],
		);
		expect(ids).toEqual(["sess-1", "sess-1__turn__2"]);
		expect(
			benchmarkAgentRuntimeCleanupInstanceIds({
				runtimeAppId: null,
				sessionId: "sess-1",
				turnCount: 0,
			}),
		).toEqual([]);
	});
});
