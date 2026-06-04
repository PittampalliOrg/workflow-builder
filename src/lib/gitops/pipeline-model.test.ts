import { describe, expect, it } from "vitest";

import type {
	DeploymentMetadataResponse,
	DesiredImageMetadata,
	GitOpsDeploymentInventory,
	GitOpsInventoryApplication,
	ImageVersion,
} from "$lib/types/deployment-metadata";
import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
} from "$lib/server/promoter/types";

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
	return {
		name,
		tag,
		commitSha: tag.replace(/^git-/, ""),
		commit: null,
		digest: "sha256:dead",
		sourceSha: tag.replace(/^git-/, ""),
	};
}

function makeMetadata(
	inventory: GitOpsDeploymentInventory | null,
	desiredImages: DesiredImageMetadata[],
	imageHistory: ImageVersion[] = [],
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
			imageHistory,
			imageHistoryError: null,
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

/**
 * Promotion fixture with a dev env in-flight: a distinct proposed dry sha plus a
 * `timer` (soak) gate still pending, mirroring a GitOps Promoter mid-soak.
 */
function makeInFlightPromotions(): PromotionStrategiesResponse {
	const strategy: PromotionStrategy = {
		metadata: { name: "workflow-builder-release", namespace: "argocd" },
		spec: {
			gitRepositoryRef: { name: "stacks" },
			environments: [{ branch: "env/spokes-dev", autoMerge: true }],
		},
		status: {
			environments: [
				{
					branch: "env/spokes-dev",
					active: {
						dry: { sha: "11111111aaaa", commitTime: "2026-06-04T12:00:00Z" },
						hydrated: { sha: "hydactive0000" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
					proposed: {
						dry: { sha: "22222222bbbb", commitTime: "2026-06-04T12:07:00Z" },
						hydrated: { sha: "hydproposed00" },
						commitStatuses: [
							{ key: "argocd-health", phase: "success" },
							{ key: "timer", phase: "pending", description: "soaking 4m of 10m" },
						],
					},
				},
			],
		},
	};
	return {
		generatedAt: "2026-06-04T12:09:00Z",
		source: "hub-inventory",
		error: null,
		changeTransferPolicies: [],
		pullRequests: [
			{
				metadata: {
					name: "wfb-promote-dev",
					namespace: "argocd",
					labels: { "promoter.argoproj.io/pull-request-url": "https://github.com/PittampalliOrg/stacks/pull/99" },
				},
				spec: { sourceBranch: "env/spokes-dev-next", targetBranch: "env/spokes-dev", state: "open" },
			},
		],
		commitStatuses: [],
		strategies: [strategy],
	};
}

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

	it("models ryzen as direct-main (no promoter tone) and dev as promoter", () => {
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
		const ryzen = stages.find((s) => s.env === "ryzen")!;
		const dev = stages.find((s) => s.env === "dev")!;
		const staging = stages.find((s) => s.env === "staging")!;

		// ryzen: direct-main, NO fabricated promoter tone — but it surfaces its
		// pin/source commit.
		expect(ryzen.deliveryMode).toBe("direct-main");
		expect(ryzen.promotion).toBeNull();
		expect(ryzen.commitSha).toBe("aaaaaaaa");
		// dev: promoter-gated.
		expect(dev.deliveryMode).toBe("promoter");
		// staging: dormant.
		expect(staging.deliveryMode).toBe("dormant");
		expect(staging.promotion).toBeNull();
	});

	it("renders pin-only env cells as 'awaiting reconcile', not healthy", () => {
		// Sandbox-only services have pin-only dev/staging cells (no inventory).
		const model = buildPipelineModel(
			makeMetadata(null, [makePin("openshell-sandbox", "git-44444444")]),
			EMPTY_PROMOTIONS,
		);
		const dev = model.stages.find((s) => s.name === "openshell-sandbox::dev")!;
		expect(dev.source).toBe("pin-only");
		expect(dev.awaitingReconcile).toBe(true);
		expect(dev.health).not.toBe("Healthy");
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

	it("emits one current freight per warehouse (incl. the bundle snapshot) when no history", () => {
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
		const wbFreights = model.freights.filter((f) => f.warehouse === "workflow-builder");
		expect(wbFreights).toHaveLength(1);
		expect(wbFreights[0]?.artifacts[0]).toMatchObject({ kind: "image", tag: "git-aaaaaaaa" });
		expect(wbFreights[0]?.current).toBe(true);
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

	// ── B2: multi-version freight stream from imageHistory ───────────────────
	it("builds a multi-version freight stream from imageHistory (newest→oldest)", () => {
		const inventory = makeInventory({
			dev: [
				makeApp({
					name: "dev-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: "git-newer000", digest: "sha256:new", commitSha: "newer000" },
				}),
			],
		});
		const history: ImageVersion[] = [
			{
				service: "workflow-builder",
				tag: "git-newer000",
				digest: "sha256:new",
				sourceSha: "newer000",
				committedAt: "2026-06-04T12:00:00Z",
				pinCommit: "pincommit2",
				pinCommittedAt: "2026-06-04T12:01:00Z",
				message: "bump to newer",
			},
			{
				service: "workflow-builder",
				tag: "git-older000",
				digest: "sha256:old",
				sourceSha: "older000",
				committedAt: "2026-06-03T12:00:00Z",
				pinCommit: "pincommit1",
				pinCommittedAt: "2026-06-03T12:01:00Z",
				message: "previous version",
			},
		];
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-newer000")], history),
			EMPTY_PROMOTIONS,
		);

		const wbFreights = model.freights.filter((f) => f.warehouse === "workflow-builder");
		// A new pin ADDS a freight (Kargo-style accumulation), it does not replace.
		expect(wbFreights).toHaveLength(2);
		// Ordered newest→oldest.
		expect(wbFreights[0]?.artifacts[0]).toMatchObject({ kind: "image", tag: "git-newer000" });
		expect(wbFreights[1]?.artifacts[0]).toMatchObject({ kind: "image", tag: "git-older000" });
		// `current` is on the freight whose tag matches the live/desired tag.
		expect(wbFreights[0]?.current).toBe(true);
		expect(wbFreights[1]?.current).toBe(false);
		// The current version sits in the dev stage (its desired tag matches).
		expect(wbFreights[0]?.inStages).toContain("workflow-builder::dev");
		// The older version is held by no live stage.
		expect(wbFreights[1]?.inStages).toEqual([]);
	});

	it("builds one bundle freight per distinct pin-commit snapshot", () => {
		const history: ImageVersion[] = [
			{
				service: "workflow-builder",
				tag: "git-newer000",
				digest: null,
				sourceSha: "newer000",
				committedAt: null,
				pinCommit: "pincommit2",
				pinCommittedAt: "2026-06-04T12:01:00Z",
				message: "snapshot 2",
			},
			{
				service: "function-router",
				tag: "git-fr000000",
				digest: null,
				sourceSha: "fr000000",
				committedAt: null,
				pinCommit: "pincommit2",
				pinCommittedAt: "2026-06-04T12:01:00Z",
				message: "snapshot 2",
			},
			{
				service: "workflow-builder",
				tag: "git-older000",
				digest: null,
				sourceSha: "older000",
				committedAt: null,
				pinCommit: "pincommit1",
				pinCommittedAt: "2026-06-03T12:01:00Z",
				message: "snapshot 1",
			},
		];
		const model = buildPipelineModel(
			makeMetadata(null, [makePin("workflow-builder", "git-newer000")], history),
			EMPTY_PROMOTIONS,
		);
		const bundleFreights = model.freights.filter((f) => f.warehouse === BUNDLE_WAREHOUSE);
		// Two distinct pin commits → two bundle freights (newest first, current).
		expect(bundleFreights).toHaveLength(2);
		expect(bundleFreights[0]?.current).toBe(true);
		expect(bundleFreights[1]?.current).toBe(false);
		expect(bundleFreights[0]?.artifacts.find((a) => a.kind === "git")).toMatchObject({
			sha: "pincommit2",
		});
	});

	// ── C1: dev in-flight promotion fields ───────────────────────────────────
	it("carries the dev in-flight promotion object (proposed, soak, PR, stalledOn)", () => {
		const inventory = makeInventory({
			dev: [makeApp({ name: "dev-workflow-builder", component: "workflow-builder" })],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-aaaaaaaa")]),
			makeInFlightPromotions(),
		);

		const dev = model.stages.find((s) => s.name === "workflow-builder::dev")!;
		expect(dev.deliveryMode).toBe("promoter");
		const promo = dev.promotion!;
		expect(promo).not.toBeNull();
		expect(promo.inFlight).toBe(true);
		expect(promo.activeTag).toBe("hydactive0000");
		expect(promo.proposedTag).toBe("hydproposed00");
		// The soak timer description is parsed.
		expect(promo.soak).toEqual({ elapsed: "4m", total: "10m", label: "4m of 10m" });
		// stalledOn is the first pending/failing gate key.
		expect(promo.stalledOn).toBe("timer");
		// The promotion PR is indexed by target branch and surfaced.
		expect(promo.pullRequest).toEqual({
			url: "https://github.com/PittampalliOrg/stacks/pull/99",
			state: "open",
		});

		// The bundle dev stage carries the same in-flight promotion.
		const bundleDev = model.stages.find((s) => s.name === `${BUNDLE_WAREHOUSE}::dev`)!;
		expect(bundleDev.promotion?.inFlight).toBe(true);
		expect(bundleDev.awaitingReconcile).toBe(true);
		// The service warehouse + bundle warehouse reflect the in-flight reconcile.
		expect(model.warehouses.find((w) => w.name === BUNDLE_WAREHOUSE)?.reconciling).toBe(true);
		expect(model.warehouses.find((w) => w.name === "workflow-builder")?.reconciling).toBe(true);
	});

	it("leaves promotion null on every stage when there is no in-flight promotion", () => {
		const inventory = makeInventory({
			dev: [makeApp({ name: "dev-workflow-builder", component: "workflow-builder" })],
		});
		const model = buildPipelineModel(
			makeMetadata(inventory, [makePin("workflow-builder", "git-aaaaaaaa")]),
			EMPTY_PROMOTIONS,
		);
		const dev = model.stages.find((s) => s.name === "workflow-builder::dev")!;
		// promoter stage exists but with no proposed freight → not in flight.
		expect(dev.deliveryMode).toBe("promoter");
		expect(dev.promotion).toBeNull();
	});
});
