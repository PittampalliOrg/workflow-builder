import { describe, expect, it } from "vitest";

import type {
	DeploymentMetadataResponse,
	GitOpsDeploymentInventory,
	GitOpsInventoryApplication,
} from "$lib/types/deployment-metadata";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

import { computePipelineGraph } from "./pipeline-layout";
import { BUNDLE_WAREHOUSE, buildPipelineModel } from "./pipeline-model";

function app(name: string, component: string): GitOpsInventoryApplication {
	return {
		name,
		component,
		desired: { image: null, tag: "git-aaaaaaaa", digest: null, commitSha: "aaaaaaaa" },
		live: { images: [], syncStatus: "Synced", healthStatus: "Healthy" },
		promotion: { drySha: null, hydratedSha: null, healthPhase: "Succeeded" },
		build: null,
		provenance: null,
		drift: { status: "in_sync" },
	};
}

function inventory(): GitOpsDeploymentInventory {
	return {
		generatedAt: "2026-06-04T12:00:00Z",
		source: "test",
		releasePins: { images: {}, error: null },
		environments: [
			{ name: "ryzen", applications: [app("ryzen-workflow-builder", "workflow-builder")] },
			{
				name: "dev",
				applications: [
					app("dev-workflow-builder", "workflow-builder"),
					app("dev-function-router", "function-router"),
				],
			},
		],
	};
}

function metadata(): DeploymentMetadataResponse {
	return {
		generatedAt: "2026-06-04T12:00:00Z",
		environment: { name: "ryzen", namespace: "workflow-builder", appUrl: null, nodeEnv: null, podName: null },
		gitops: {
			releasePinsSourceUrl: "",
			releasePinsFetchedAt: null,
			releasePinsError: null,
			stacksMain: { sha: "abcdef1234", shortSha: "abcdef1", url: "", message: null, authorName: null, committedAt: null },
			desiredImages: [
				{ name: "workflow-builder", tag: "git-aaaaaaaa", commitSha: "aaaaaaaa", commit: null },
				{ name: "function-router", tag: "git-bbbbbbbb", commitSha: "bbbbbbbb", commit: null },
			],
			imageHistory: [],
			imageHistoryError: null,
		},
		live: { deployments: [], error: null },
		inventory: { sourceUrl: null, fetchedAt: null, error: null, data: inventory() },
	};
}

const EMPTY_PROMOTIONS: PromotionStrategiesResponse = {
	generatedAt: null,
	source: "empty",
	strategies: [],
	changeTransferPolicies: [],
	pullRequests: [],
	commitStatuses: [],
	error: null,
};

describe("computePipelineGraph", () => {
	const model = buildPipelineModel(metadata(), EMPTY_PROMOTIONS);

	it("lays out warehouse + stage nodes with finite positions (subscriptions hidden)", () => {
		const { nodes } = computePipelineGraph(model, { hideSubscriptions: true });
		expect(nodes.length).toBeGreaterThan(0);
		expect(nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
		expect(nodes.some((n) => n.id.startsWith("warehouse/"))).toBe(true);
		expect(nodes.some((n) => n.id.startsWith("stage/"))).toBe(true);
		expect(nodes.some((n) => n.id.startsWith("subscription/"))).toBe(false);
	});

	it("renders subscription nodes when not hidden", () => {
		const { nodes } = computePipelineGraph(model, { hideSubscriptions: false });
		expect(nodes.some((n) => n.id.startsWith("subscription/"))).toBe(true);
	});

	it("keys warehouse→stage edge handles to the warehouse name", () => {
		const { edges } = computePipelineGraph(model, { hideSubscriptions: true });
		const wbEdge = edges.find((e) => e.source === "warehouse/workflow-builder" && e.target === "stage/workflow-builder::ryzen");
		expect(wbEdge).toBeDefined();
		expect(wbEdge?.sourceHandle).toBe("workflow-builder");
		expect(wbEdge?.targetHandle).toBe("workflow-builder");
	});

	it("isolates a single pipeline via the warehouse filter", () => {
		const { nodes } = computePipelineGraph(model, {
			pipelineFilter: ["workflow-builder"],
			hideSubscriptions: true,
		});
		// Only workflow-builder's warehouse + stages — bundle and function-router excluded.
		expect(nodes.some((n) => n.id === `warehouse/${BUNDLE_WAREHOUSE}`)).toBe(false);
		expect(nodes.some((n) => n.id === "warehouse/function-router")).toBe(false);
		expect(nodes.some((n) => n.id === "warehouse/workflow-builder")).toBe(true);
		expect(nodes.filter((n) => n.id.startsWith("stage/")).every((n) => n.id.includes("workflow-builder"))).toBe(true);
	});

	it("collapses env stages into one lane node per warehouse when groupLanes is set", () => {
		const { nodes, edges } = computePipelineGraph(model, { groupLanes: true, hideSubscriptions: true });
		// Lane nodes replace individual stage nodes.
		expect(nodes.some((n) => n.id.startsWith("lane/"))).toBe(true);
		expect(nodes.some((n) => n.id.startsWith("stage/"))).toBe(false);
		expect(nodes.some((n) => n.id === "lane/workflow-builder")).toBe(true);
		// warehouse → lane edge.
		const laneEdge = edges.find((e) => e.target === "lane/workflow-builder");
		expect(laneEdge?.source).toBe("warehouse/workflow-builder");
		// The lane node carries all of the warehouse's env stages.
		const lane = nodes.find((n) => n.id === "lane/workflow-builder");
		const stages = (lane?.data as { stages?: unknown[] } | undefined)?.stages ?? [];
		expect(stages.length).toBeGreaterThanOrEqual(2);
	});
});
