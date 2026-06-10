import { describe, expect, it } from "vitest";

import {
	stageMatchesAnyStatus,
	stageMatchesStatus,
	statusCounts,
} from "./stage-status-filters";
import type { PipelineStage } from "./pipeline-types";

describe("stageMatchesStatus", () => {
	it("failing: Degraded health, failed build, or failed activity", () => {
		expect(stageMatchesStatus(stage({ health: "Degraded" }), "failing")).toBe(true);
		expect(
			stageMatchesStatus(stage({ build: build("failed") }), "failing"),
		).toBe(true);
		expect(
			stageMatchesStatus(stage({ activity: activity({ failed: true }) }), "failing"),
		).toBe(true);
		expect(stageMatchesStatus(stage({}), "failing")).toBe(false);
	});

	it("building: only an in-progress build", () => {
		expect(stageMatchesStatus(stage({ build: build("building") }), "building")).toBe(true);
		expect(stageMatchesStatus(stage({ build: build("built") }), "building")).toBe(false);
		expect(stageMatchesStatus(stage({}), "building")).toBe(false);
	});

	it("drifting: pending_rollout, OutOfSync, or live≠desired tag", () => {
		expect(stageMatchesStatus(stage({ drift: "pending_rollout" }), "drifting")).toBe(true);
		expect(stageMatchesStatus(stage({ syncStatus: "OutOfSync" }), "drifting")).toBe(true);
		expect(
			stageMatchesStatus(stage({ liveTag: "git-old", desiredTag: "git-new" }), "drifting"),
		).toBe(true);
		expect(stageMatchesStatus(stage({ liveTag: null }), "drifting")).toBe(false);
		expect(stageMatchesStatus(stage({}), "drifting")).toBe(false);
	});

	it("promoting: only an in-flight promotion", () => {
		expect(
			stageMatchesStatus(stage({ promotion: promotion(true) }), "promoting"),
		).toBe(true);
		expect(
			stageMatchesStatus(stage({ promotion: promotion(false) }), "promoting"),
		).toBe(false);
		expect(stageMatchesStatus(stage({}), "promoting")).toBe(false);
	});
});

describe("stageMatchesAnyStatus", () => {
	it("matches all when no filters are active", () => {
		expect(stageMatchesAnyStatus(stage({}), [])).toBe(true);
	});

	it("ORs the active filters", () => {
		const s = stage({ build: build("building") });
		expect(stageMatchesAnyStatus(s, ["failing", "building"])).toBe(true);
		expect(stageMatchesAnyStatus(s, ["failing", "drifting"])).toBe(false);
	});
});

describe("statusCounts", () => {
	it("counts each filter independently (a stage may match several)", () => {
		const stages = [
			stage({ health: "Degraded", syncStatus: "OutOfSync" }),
			stage({ build: build("building") }),
			stage({ promotion: promotion(true) }),
			stage({}),
		];
		expect(statusCounts(stages)).toEqual({
			failing: 1,
			building: 1,
			drifting: 1,
			promoting: 1,
		});
	});
});

function build(phase: "building" | "built" | "failed") {
	return { pipelineRun: "pr-1", phase, startedAt: null, finishedAt: null, durationMs: null };
}

function promotion(inFlight: boolean) {
	return {
		inFlight,
		proposedTag: null,
		activeTag: null,
		activeAt: null,
		gates: [],
		soak: null,
		pullRequest: null,
		stalledOn: null,
	};
}

function activity(overrides: { failed?: boolean; passing?: boolean }) {
	return {
		eventId: "e1",
		sequence: 1,
		source: "tekton",
		activityType: "tekton.pipelinerun",
		phase: null,
		reason: null,
		message: null,
		observedAt: "2026-06-10T12:00:00Z",
		passing: overrides.passing ?? false,
		failed: overrides.failed ?? false,
	};
}

function stage(overrides: Partial<PipelineStage>): PipelineStage {
	return {
		name: "workflow-builder::dev",
		warehouse: "workflow-builder",
		env: "dev",
		requestedFreight: [],
		health: "Healthy",
		syncStatus: "Synced",
		promotionPhase: null,
		drift: null,
		desiredTag: "git-abc1234",
		liveTag: "git-abc1234",
		commitSha: "abc1234",
		source: "inventory",
		updatedAt: "2026-06-10T12:00:00Z",
		controlFlow: false,
		dormant: false,
		deliveryMode: "promoter",
		awaitingReconcile: false,
		promotion: null,
		...overrides,
	};
}
