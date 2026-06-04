import { describe, expect, it } from "vitest";

import type {
	DeploymentMetadataResponse,
	DesiredImageMetadata,
	GitOpsDeploymentInventory,
	GitOpsInventoryApplication,
} from "$lib/types/deployment-metadata";
import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

import { BUNDLE_WAREHOUSE, RELEASE_TRAIN_SUBSYSTEM, buildPipelineModel } from "./pipeline-model";

function makeApp(overrides: Partial<GitOpsInventoryApplication>): GitOpsInventoryApplication {
	return {
		name: overrides.name ?? "dev-workflow-builder",
		component: overrides.component ?? "workflow-builder",
		desired: {
			image: "ghcr.io/pittampalliorg/workflow-builder:git-aaaaaaaa",
			tag: "git-aaaaaaaa",
			digest: "sha256:abcdef",
			commitSha: "aaaaaaaa",
			...(overrides.desired ?? {}),
		},
		live: {
			images: ["ghcr.io/pittampalliorg/workflow-builder:git-aaaaaaaa"],
			syncStatus: "Synced",
			healthStatus: "Healthy",
			...(overrides.live ?? {}),
		},
		promotion: overrides.promotion ?? { drySha: null, hydratedSha: "aaaaaaaa", healthPhase: "Succeeded" },
		build: overrides.build ?? null,
		provenance: overrides.provenance ?? null,
		drift: overrides.drift ?? { status: "in_sync" },
	};
}

function makeInventory(apps: Record<string, GitOpsInventoryApplication[]>): GitOpsDeploymentInventory {
	return {
		generatedAt: "2026-06-04T12:00:00Z",
		source: "test",
		releasePins: { images: {}, error: null },
		environments: Object.entries(apps).map(([name, applications]) => ({ name, applications })),
	};
}

function makePin(name: string, tag: string): DesiredImageMetadata {
	return { name, tag, commitSha: tag.replace(/^git-/, ""), commit: null, digest: "sha256:dead", sourceSha: tag.replace(/^git-/, "") };
}

function makeMetadata(
	inventory: GitOpsDeploymentInventory | null,
	desiredImages: DesiredImageMetadata[],
): DeploymentMetadataResponse {
	return {
		generatedAt: "2026-06-04T12:00:00Z",
		environment: { name: "ryzen", namespace: "workflow-builder", appUrl: null, nodeEnv: null, podName: null },
		gitops: {
			releasePinsSourceUrl: "",
			releasePinsFetchedAt: null,
			releasePinsError: null,
			stacksMain: {
				sha: "abcdef1234567890",
				shortSha: "abcdef1",
				url: "https://example/commit/abcdef1",
				message: null,
				authorName: null,
				committedAt: "2026-06-04T11:00:00Z",
			},
			desiredImages,
		},
		live: { deployments: [], error: null },
		inventory: { sourceUrl: null, fetchedAt: null, error: null, data: inventory },
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

describe("buildPipelineModel", () => {
	it("creates a release-train bundle warehouse first, plus per-service warehouses", () => {
		const inventory = makeInventory({
			ryzen: [makeApp({ name: "ryzen-workflow-builder", component: "workflow-builder" })],
			dev: [makeApp({ name: "dev-workflow-builder", component: "workflow-builder" })],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-aaaaaaaa")]),
			EMPTY_PROMOTIONS,
		);

		expect(model.warehouses[0].name).toBe(BUNDLE_WAREHOUSE);
		expect(model.warehouses[0].kind).toBe("bundle");
		expect(model.warehouses.some((w) => w.name === "workflow-builder" && w.kind === "service")).toBe(true);
		// Bundle warehouse subscribes to images + git config.
		expect(model.warehouses[0].subscriptions.map((s) => s.type).sort()).toEqual(["git", "image"]);
		// Every warehouse gets an identity colour.
		expect(model.warehouseColorMap[BUNDLE_WAREHOUSE]).toMatch(/^#/);
		expect(model.subsystems[0]).toBe(RELEASE_TRAIN_SUBSYSTEM);
	});

	it("builds ryzen/dev/staging stages with direct + downstream edges for a regular service", () => {
		const inventory = makeInventory({
			ryzen: [makeApp({ name: "ryzen-workflow-builder", component: "workflow-builder" })],
			dev: [makeApp({ name: "dev-workflow-builder", component: "workflow-builder" })],
			staging: [makeApp({ name: "staging-workflow-builder", component: "workflow-builder" })],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-aaaaaaaa")]),
			EMPTY_PROMOTIONS,
		);

		const stages = model.stages.filter((s) => s.warehouse === "workflow-builder");
		expect(stages.map((s) => s.env).sort()).toEqual(["dev", "ryzen", "staging"]);

		const ryzen = stages.find((s) => s.env === "ryzen")!;
		expect(ryzen.requestedFreight[0].sources.direct).toBe(true);
		const dev = stages.find((s) => s.env === "dev")!;
		expect(dev.requestedFreight[0].sources.direct).toBe(true);
		// Staging is downstream of dev (verified-upstream), and dormant.
		const staging = stages.find((s) => s.env === "staging")!;
		expect(staging.requestedFreight[0].sources.stages).toEqual(["workflow-builder::dev"]);
		expect(staging.dormant).toBe(true);
		expect(ryzen.health).toBe("Healthy");
	});

	it("omits the ryzen stage for sandbox-only services", () => {
		const model = buildPipelineModel(
			makeMetadata(null, [makePin("openshell-sandbox", "git-44444444")]),
			EMPTY_PROMOTIONS,
		);
		const stages = model.stages.filter((s) => s.warehouse === "openshell-sandbox");
		expect(stages.some((s) => s.env === "ryzen")).toBe(false);
		expect(stages.some((s) => s.env === "dev")).toBe(true);
	});

	it("emits one current freight per warehouse (incl. the bundle snapshot)", () => {
		const inventory = makeInventory({
			dev: [makeApp({ name: "dev-workflow-builder", component: "workflow-builder" })],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-aaaaaaaa")]),
			EMPTY_PROMOTIONS,
		);
		const bundle = model.freights.find((f) => f.warehouse === BUNDLE_WAREHOUSE);
		expect(bundle).toBeDefined();
		expect(bundle?.artifacts.some((a) => a.kind === "git")).toBe(true);
		const wbFreight = model.freights.find((f) => f.warehouse === "workflow-builder");
		expect(wbFreight?.artifacts[0]).toMatchObject({ kind: "image", tag: "git-aaaaaaaa" });
	});

	it("computes per-env roll-ups on the release-train bundle dev stage", () => {
		const inventory = makeInventory({
			dev: [
				makeApp({ name: "dev-workflow-builder", component: "workflow-builder" }),
				makeApp({
					name: "dev-function-router",
					component: "function-router",
					live: { images: [], syncStatus: "OutOfSync", healthStatus: "Healthy" },
					drift: { status: "pending_rollout" },
				}),
			],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-a"), makePin("function-router", "git-b")]),
			EMPTY_PROMOTIONS,
		);
		const bundleDev = model.stages.find((s) => s.name === `${BUNDLE_WAREHOUSE}::dev`)!;
		expect(bundleDev.rollup?.total).toBe(2);
		expect(bundleDev.rollup?.synced).toBe(1);
		expect(bundleDev.rollup?.drift).toBe(1);
	});
});
