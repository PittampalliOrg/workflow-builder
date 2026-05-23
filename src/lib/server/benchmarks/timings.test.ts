import { describe, expect, it } from "vitest";
import {
	buildSessionTimingPatchForTest,
	buildWorkflowTimingPatchForTest,
} from "./timings";

const at = (iso: string) => new Date(iso);

describe("benchmark timing rollups", () => {
	it("summarizes model, tool, and active turn timings from session events", () => {
		const patch = buildSessionTimingPatchForTest([
			{
				type: "session.turn_started",
				data: { turn: 1 },
				createdAt: at("2026-05-03T12:00:00Z"),
			},
			{
				type: "agent.llm_usage",
				data: { duration_ms: 10_000 },
				createdAt: at("2026-05-03T12:00:10Z"),
			},
			{
				type: "agent.llm_usage",
				data: { duration_ms: 40_000 },
				createdAt: at("2026-05-03T12:01:00Z"),
			},
			{
				type: "agent.tool_result",
				data: { duration_ms: 2_500 },
				createdAt: at("2026-05-03T12:01:05Z"),
			},
			{
				type: "session.turn_heartbeat",
				data: { elapsed_seconds: 120 },
				createdAt: at("2026-05-03T12:02:00Z"),
			},
		]);

		expect(patch).toMatchObject({
			llm_count: 2,
			llm_duration_ms: 50_000,
			llm_duration_p50_ms: 10_000,
			llm_duration_p90_ms: 10_000,
			llm_duration_max_ms: 40_000,
			tool_count: 1,
			tool_duration_ms: 2_500,
			active_turn_elapsed_ms: 120_000,
			latest_turn_heartbeat_seconds: 120,
			last_session_event_type: "session.turn_heartbeat",
		});
	});

	it("records completed turn duration when the session terminates", () => {
		const patch = buildSessionTimingPatchForTest([
			{
				type: "session.turn_started",
				data: { turn: 1 },
				createdAt: at("2026-05-03T12:00:00Z"),
			},
			{
				type: "session.status_terminated",
				data: {},
				createdAt: at("2026-05-03T12:03:15Z"),
			},
		]);

		expect(patch).toMatchObject({
			turn_started_at: "2026-05-03T12:00:00.000Z",
			turn_completed_at: "2026-05-03T12:03:15.000Z",
			turn_duration_ms: 195_000,
			active_turn_elapsed_ms: null,
		});
	});

	it("records first tool scheduled-to-start latency and missing-start watchdog state", () => {
		const startedPatch = buildSessionTimingPatchForTest([
			{
				type: "tool_activity.scheduled",
				data: { tool: "BashRun" },
				createdAt: at("2026-05-03T12:00:10Z"),
			},
			{
				type: "tool_activity.started",
				data: { tool: "BashRun" },
				createdAt: at("2026-05-03T12:00:42Z"),
			},
		]);

		expect(startedPatch).toMatchObject({
			first_tool_scheduled_at: "2026-05-03T12:00:10.000Z",
			first_tool_started_at: "2026-05-03T12:00:42.000Z",
			first_tool_scheduled_to_started_ms: 32_000,
			first_tool_scheduled_without_started: false,
		});

		const stuckPatch = buildSessionTimingPatchForTest(
			[
				{
					type: "tool_activity.scheduled",
					data: { tool: "BashRun" },
					createdAt: at("2026-05-03T12:00:10Z"),
				},
				{
					type: "session.turn_heartbeat",
					data: {},
					createdAt: at("2026-05-03T12:01:10Z"),
				},
			],
			{ now: at("2026-05-03T12:01:10Z") },
		);

		expect(stuckPatch).toMatchObject({
			first_tool_scheduled_without_started: true,
			first_tool_scheduled_without_started_ms: 60_000,
		});
	});

	it("maps SWE-bench workflow step logs into phase timings", () => {
		const patch = buildWorkflowTimingPatchForTest({
			runInstance: {
				startedAt: at("2026-05-03T12:00:00Z"),
				inferenceCompletedAt: at("2026-05-03T12:05:00Z"),
			},
			execution: {
				startedAt: at("2026-05-03T11:59:50Z"),
				completedAt: at("2026-05-03T12:05:10Z"),
				duration: null,
			},
			logs: [
				{
					nodeId: "workspace_profile",
					duration: "45000",
					startedAt: at("2026-05-03T11:59:50Z"),
					completedAt: at("2026-05-03T12:00:35Z"),
				},
				{
					nodeId: "checkout_repo",
					duration: "90000",
					startedAt: at("2026-05-03T12:00:35Z"),
					completedAt: at("2026-05-03T12:02:05Z"),
				},
				{
					nodeId: "solve",
					duration: "150000",
					startedAt: at("2026-05-03T12:02:05Z"),
					completedAt: at("2026-05-03T12:04:35Z"),
				},
			],
		});

		expect(patch).toMatchObject({
			inference_duration_ms: 300_000,
			workflow_duration_ms: 320_000,
			workflow_logged_step_count: 3,
			workspace_profile_duration_ms: 45_000,
			sandbox_startup_ms: 45_000,
			checkout_repo_duration_ms: 90_000,
			repo_checkout_ms: 90_000,
			solve_duration_ms: 150_000,
			agent_solve_ms: 150_000,
		});
	});
});
