import { describe, expect, it } from "vitest";

import {
	activityEventLabel,
	activityEventTone,
	activityTargetKeys,
	applyPipelineActivityOverlay,
	eventsForSelection,
} from "./activity-overlay";
import { pipelineActivityTone, toneClasses } from "./activity-tone";
import type { PipelineModel } from "./pipeline-types";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

// A fixed "now" 30s after the fixtures' observedAt — inside the 30-min active window.
const NOW = Date.parse("2026-06-05T12:01:00Z");

describe("applyPipelineActivityOverlay", () => {
	it("attaches activity to the matching service stage without mutating inventory", () => {
		const overlaid = applyPipelineActivityOverlay(baseModel(), [
			event({
				sequence: 10,
				source: "tekton",
				activityType: "tekton.pipelinerun",
				phase: "Running",
				correlation: { imageName: "workflow-builder", cluster: "dev" },
			}),
		]);

		const stage = overlaid.stages.find((s) => s.name === "workflow-builder::dev");
		expect(stage?.activity?.activityType).toBe("tekton.pipelinerun");
		expect(pipelineActivityTone(stage!.activity!, NOW)).toBe("active");
		// Inventory snapshot stays authoritative — overlay never overwrites it.
		expect(stage?.health).toBe("Healthy");
		expect(stage?.syncStatus).toBe("Synced");
		const warehouse = overlaid.warehouses.find((w) => w.name === "workflow-builder");
		expect(warehouse?.activity?.activityType).toBe("tekton.pipelinerun");
		expect(warehouse?.reconciling).toBe(false);
		expect(warehouse?.hasError).toBe(false);
	});

	it("maps Promoter events to the release-pins dev bundle stage without mutating inventory", () => {
		const overlaid = applyPipelineActivityOverlay(baseModel(), [
			event({
				sequence: 11,
				source: "promoter",
				activityType: "promoter.commitstatus",
				phase: "failure",
				reason: "argocd-health",
				correlation: { branch: "env/spokes-dev" },
			}),
		]);

		const stage = overlaid.stages.find((s) => s.name === "release-pins::dev");
		expect(stage?.activity?.failed).toBe(true);
		expect(pipelineActivityTone(stage!.activity!, NOW)).toBe("failed");
		// Inventory snapshot stays authoritative.
		expect(stage?.health).toBe("Healthy");
		expect(stage?.syncStatus).toBe("Synced");
		const warehouse = overlaid.warehouses.find((w) => w.name === "release-pins");
		expect(warehouse?.activity?.failed).toBe(true);
		expect(warehouse?.reconciling).toBe(false);
		expect(warehouse?.hasError).toBe(false);
	});

	it("targets the service stage from an ArgoCD application event, leaving inventory untouched", () => {
		const overlaid = applyPipelineActivityOverlay(baseModel(), [
			event({
				sequence: 12,
				source: "argocd",
				activityType: "argocd.application",
				phase: "Progressing",
				correlation: {
					argocdApp: "dev-workflow-builder",
					syncStatus: "OutOfSync",
					healthStatus: "Progressing",
					syncRevision: "abc",
				},
			}),
		]);

		const stage = overlaid.stages.find((s) => s.name === "workflow-builder::dev");
		expect(stage?.activity?.activityType).toBe("argocd.application");
		expect(stage?.health).toBe("Healthy");
		expect(stage?.syncStatus).toBe("Synced");
		const warehouse = overlaid.warehouses.find((w) => w.name === "workflow-builder");
		expect(warehouse?.activity?.activityType).toBe("argocd.application");
		expect(warehouse?.reconciling).toBe(false);
		expect(warehouse?.hasError).toBe(false);
	});

	it("marks a terminal Succeeded Tekton event as passing, not active or failed", () => {
		const overlaid = applyPipelineActivityOverlay(baseModel(), [
			event({
				sequence: 13,
				source: "tekton",
				activityType: "tekton.pipelinerun",
				phase: "Succeeded",
				correlation: { imageName: "workflow-builder", cluster: "dev" },
			}),
		]);

		const stage = overlaid.stages.find((s) => s.name === "workflow-builder::dev");
		expect(stage?.activity?.passing).toBe(true);
		expect(stage?.activity?.failed).toBe(false);
		expect(pipelineActivityTone(stage!.activity!, NOW)).toBe("passing");
	});

	it("correlates a Tekton event by gitSha embedded in a stage tag (reverse index)", () => {
		const overlaid = applyPipelineActivityOverlay(baseModel(), [
			event({
				sequence: 14,
				source: "tekton",
				activityType: "tekton.taskrun",
				phase: "Running",
				correlation: { gitSha: "abc1234deadbeef", cluster: "dev" },
			}),
		]);
		// baseModel's workflow-builder::dev stage has desiredTag "git-abc1234".
		const stage = overlaid.stages.find((s) => s.name === "workflow-builder::dev");
		expect(stage?.activity?.activityType).toBe("tekton.taskrun");
	});
});

describe("activityTargetKeys", () => {
	const model = baseModel();
	it("returns both the warehouse and stage keys for a correlated event", () => {
		const keys = activityTargetKeys(
			event({
				source: "tekton",
				activityType: "tekton.pipelinerun",
				correlation: { imageName: "workflow-builder", cluster: "dev" },
			}),
			model,
		);
		expect(keys).toContain("workflow-builder");
		expect(keys).toContain("workflow-builder::dev");
	});

	it("returns an empty array for an uncorrelated event", () => {
		const keys = activityTargetKeys(
			event({ source: "tekton", activityType: "tekton.pipelinerun", correlation: {} }),
			model,
		);
		expect(keys).toEqual([]);
	});
});

describe("eventsForSelection", () => {
	const model = baseModel();
	const events = [
		event({
			sequence: 10,
			source: "tekton",
			activityType: "tekton.pipelinerun",
			phase: "Running",
			correlation: { imageName: "workflow-builder", cluster: "dev" },
		}),
		event({
			sequence: 11,
			source: "argocd",
			activityType: "argocd.application",
			phase: "Progressing",
			correlation: { argocdApp: "dev-workflow-builder" },
		}),
		event({
			sequence: 12,
			source: "promoter",
			activityType: "promoter.commitstatus",
			phase: "success",
			correlation: { branch: "env/spokes-dev" },
		}),
	];

	it("returns the matching service events newest-first for a stage selection", () => {
		const matched = eventsForSelection(
			events,
			{ kind: "stage", id: "stage/workflow-builder::dev" },
			model,
		);
		expect(matched.map((e) => e.sequence)).toEqual([11, 10]);
	});

	it("returns the promoter event for the release-pins stage", () => {
		const matched = eventsForSelection(
			events,
			{ kind: "stage", id: "stage/release-pins::dev" },
			model,
		);
		expect(matched.map((e) => e.sequence)).toEqual([12]);
	});

	it("mirrors stage matches for a warehouse selection", () => {
		const matched = eventsForSelection(
			events,
			{ kind: "warehouse", id: "warehouse/workflow-builder" },
			model,
		);
		expect(matched.map((e) => e.sequence)).toEqual([11, 10]);
	});

	it("returns nothing for a subscription selection", () => {
		expect(
			eventsForSelection(events, { kind: "subscription", id: "sub/anything" }, model),
		).toEqual([]);
	});
});

describe("activityEventTone", () => {
	it("returns failed for a failed phase", () => {
		expect(activityEventTone(event({ phase: "Failed" }))).toBe("failed");
	});

	it("returns passing for a terminal Succeeded/Healthy phase", () => {
		expect(activityEventTone(event({ phase: "Succeeded" }))).toBe("passing");
		expect(activityEventTone(event({ phase: "Healthy" }))).toBe("passing");
	});

	it("returns active for a fresh non-terminal phase", () => {
		const e = event({ phase: "Running" });
		e.observedAt = new Date().toISOString();
		expect(activityEventTone(e)).toBe("active");
	});

	it("returns neutral for a stale non-terminal phase", () => {
		const e = event({ phase: "Running" });
		e.observedAt = "2020-01-01T00:00:00Z";
		expect(activityEventTone(e)).toBe("neutral");
	});

	it("honours a supplied now for the freshness window", () => {
		const e = event({ phase: "Running" });
		e.observedAt = "2026-06-05T12:00:30Z";
		// 31 minutes later → outside the 30-min active window.
		expect(activityEventTone(e, Date.parse("2026-06-05T12:31:30Z"))).toBe("neutral");
		expect(activityEventTone(e, NOW)).toBe("active");
	});
});

describe("pipelineActivityTone + toneClasses", () => {
	it("derives the 4-way tone from baked flags + freshness", () => {
		expect(pipelineActivityTone({ failed: true, passing: false, observedAt: "" }, NOW)).toBe(
			"failed",
		);
		expect(pipelineActivityTone({ failed: false, passing: true, observedAt: "" }, NOW)).toBe(
			"passing",
		);
		expect(
			pipelineActivityTone(
				{ failed: false, passing: false, observedAt: "2026-06-05T12:00:30Z" },
				NOW,
			),
		).toBe("active");
		expect(
			pipelineActivityTone(
				{ failed: false, passing: false, observedAt: "2020-01-01T00:00:00Z" },
				NOW,
			),
		).toBe("neutral");
	});

	it("exposes a class token set per tone", () => {
		for (const tone of ["failed", "passing", "active", "neutral"] as const) {
			const classes = toneClasses(tone);
			expect(classes.border).toBeTruthy();
			expect(classes.bg).toBeTruthy();
			expect(classes.text).toBeTruthy();
			expect(classes.dot).toBeTruthy();
		}
	});
});

describe("activityEventLabel", () => {
	it("prefers the correlation imageName", () => {
		expect(activityEventLabel(event({ correlation: { imageName: "workflow-builder" } }))).toBe(
			"workflow-builder",
		);
	});

	it("falls back to the resourceRef name when imageName is absent", () => {
		expect(activityEventLabel(event({ correlation: {} }))).toBe("pr");
	});

	it("falls back to the activityKey when both imageName and resourceRef name are absent", () => {
		const e = event({ correlation: {} });
		e.resourceRef = { ...e.resourceRef, name: null };
		expect(activityEventLabel(e)).toBe("workflow-builder:dev");
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
			stage("release-pins::dev", "release-pins", "aaaaaaa"),
			stage("workflow-builder::dev", "workflow-builder", "abc1234"),
		],
	};
}

function stage(name: string, warehouse: string, sha: string): PipelineModel["stages"][number] {
	return {
		name,
		warehouse,
		env: "dev",
		requestedFreight: [],
		health: "Healthy",
		syncStatus: "Synced",
		promotionPhase: null,
		drift: null,
		desiredTag: `git-${sha}`,
		liveTag: `git-${sha}`,
		commitSha: sha,
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
