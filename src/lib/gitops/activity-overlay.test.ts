import { describe, expect, it } from "vitest";

import { applyPipelineActivityOverlay } from "./activity-overlay";
import type { PipelineModel } from "./pipeline-types";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

describe("applyPipelineActivityOverlay", () => {
	it("marks the matching service stage progressing from a fresh Tekton event", () => {
		const overlaid = applyPipelineActivityOverlay(
			baseModel(),
			[
				event({
					sequence: 10,
					source: "tekton",
					activityType: "tekton.pipelinerun",
					phase: "Running",
					correlation: { imageName: "workflow-builder", cluster: "dev" },
				}),
			],
			Date.parse("2026-06-05T12:01:00Z"),
		);

		const stage = overlaid.stages.find((s) => s.name === "workflow-builder::dev");
		expect(stage?.activity?.activityType).toBe("tekton.pipelinerun");
		expect(stage?.health).toBe("Progressing");
		expect(overlaid.warehouses.find((w) => w.name === "workflow-builder")?.reconciling).toBe(true);
	});

	it("maps Promoter events to the release-pins dev bundle stage", () => {
		const overlaid = applyPipelineActivityOverlay(
			baseModel(),
			[
				event({
					sequence: 11,
					source: "promoter",
					activityType: "promoter.commitstatus",
					phase: "failure",
					reason: "argocd-health",
					correlation: { branch: "env/spokes-dev" },
				}),
			],
			Date.parse("2026-06-05T12:01:00Z"),
		);

		const stage = overlaid.stages.find((s) => s.name === "release-pins::dev");
		expect(stage?.activity?.failed).toBe(true);
		expect(stage?.health).toBe("Degraded");
		expect(overlaid.warehouses.find((w) => w.name === "release-pins")?.hasError).toBe(true);
	});
});

function baseModel(): PipelineModel {
	return {
		generatedAt: "2026-06-05T12:00:00Z",
		warehouseColorMap: {
			"release-pins": "#111111",
			"workflow-builder": "#222222",
		},
		stageColorMap: {
			"release-pins::dev": "#111111",
			"workflow-builder::dev": "#222222",
		},
		subsystems: ["Release train", "Core platform"],
		warehousesBySubsystem: {},
		freights: [],
		warehouses: [
			{
				name: "release-pins",
				kind: "bundle",
				subsystem: "Release train",
				subscriptions: [],
				reconciling: false,
				hasError: false,
				specialCase: null,
			},
			{
				name: "workflow-builder",
				kind: "service",
				subsystem: "Core platform",
				subscriptions: [],
				reconciling: false,
				hasError: false,
				specialCase: null,
			},
		],
		stages: [
			stage("release-pins::dev", "release-pins"),
			stage("workflow-builder::dev", "workflow-builder"),
		],
	};
}

function stage(name: string, warehouse: string): PipelineModel["stages"][number] {
	return {
		name,
		warehouse,
		env: "dev",
		requestedFreight: [],
		health: "Healthy",
		syncStatus: "Synced",
		promotionPhase: null,
		drift: null,
		desiredTag: "git-abc",
		liveTag: "git-abc",
		commitSha: "abc",
		source: "inventory",
		updatedAt: "2026-06-05T12:00:00Z",
		controlFlow: false,
		dormant: false,
		deliveryMode: "promoter",
		awaitingReconcile: false,
		promotion: null,
	};
}

function event(overrides: Partial<GitOpsActivityEvent>): GitOpsActivityEvent {
	return {
		eventId: `evt-${overrides.sequence ?? 1}`,
		sequence: overrides.sequence ?? 1,
		source: overrides.source ?? "tekton",
		activityKey: "workflow-builder:dev",
		activityType: overrides.activityType ?? "tekton.pipelinerun",
		phase: overrides.phase ?? "Running",
		reason: overrides.reason ?? null,
		message: overrides.message ?? null,
		resourceRef: {
			group: "tekton.dev",
			version: "v1",
			resource: "pipelineruns",
			kind: "PipelineRun",
			namespace: "tekton-pipelines",
			name: "pr",
			uid: "uid",
		},
		observedAt: "2026-06-05T12:00:30Z",
		correlation: overrides.correlation ?? {},
		raw: {},
		createdAt: "2026-06-05T12:00:30Z",
		updatedAt: "2026-06-05T12:00:30Z",
	};
}
