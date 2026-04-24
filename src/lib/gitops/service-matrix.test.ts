import { describe, expect, it } from "vitest";

import type {
	DesiredImageMetadata,
	GitOpsDeploymentInventory,
	GitOpsInventoryApplication,
} from "$lib/types/deployment-metadata";

import {
	buildServiceMatrix,
	specialCaseFor,
	summarizeMatrix,
	WB_SERVICES,
} from "./service-matrix";

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
		promotion: overrides.promotion ?? {
			drySha: null,
			hydratedSha: "aaaaaaaa",
			healthPhase: "Succeeded",
		},
		build: overrides.build ?? {
			pipelineRun: "pr-abc",
			status: "True",
			reason: "Succeeded",
			startedAt: "2026-04-24T12:00:00Z",
			finishedAt: "2026-04-24T12:03:00Z",
		},
		provenance: overrides.provenance ?? {
			"org.opencontainers.image.created": "2026-04-24T12:03:00Z",
		},
		drift: overrides.drift ?? { status: "in_sync" },
	};
}

function makeInventory(apps: Record<string, GitOpsInventoryApplication[]>): GitOpsDeploymentInventory {
	return {
		generatedAt: "2026-04-24T12:05:00Z",
		source: "test",
		releasePins: { images: {}, error: null },
		environments: Object.entries(apps).map(([name, applications]) => ({
			name,
			applications,
		})),
	};
}

function makePin(name: string, tag: string): DesiredImageMetadata {
	const commitSha = tag.replace(/^git-/, "");
	return {
		name,
		tag,
		commitSha,
		commit: null,
	};
}

describe("specialCaseFor", () => {
	it("categorises every service", () => {
		expect(specialCaseFor("workflow-builder")).toBeNull();
		expect(specialCaseFor("agent-runtime-controller")).toBe("single-source");
		expect(specialCaseFor("openshell-sandbox")).toBe("sandbox-only");
		expect(specialCaseFor("dapr-agent-py-sandbox")).toBe("sandbox-only");
		expect(specialCaseFor("browser-use-agent-sandbox")).toBe("sandbox-only");
		expect(specialCaseFor("openshell-sandbox-xlsx")).toBe("sandbox-only");
		expect(specialCaseFor("mcp-gateway")).toBe("ryzen-missing-pin");
		expect(specialCaseFor("openshell-agent-runtime")).toBe("ryzen-only");
	});
});

describe("buildServiceMatrix", () => {
	it("happy path: workflow-builder populated on all three envs", () => {
		const inventory = makeInventory({
			ryzen: [
				makeApp({
					name: "ryzen-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: "git-11111111", digest: null, commitSha: "11111111" },
				}),
			],
			dev: [
				makeApp({
					name: "dev-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: "git-11111111", digest: null, commitSha: "11111111" },
				}),
			],
			staging: [
				makeApp({
					name: "staging-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: "git-11111111", digest: null, commitSha: "11111111" },
				}),
			],
		});

		const rows = buildServiceMatrix({
			inventory,
			releasePins: [makePin("workflow-builder", "git-11111111")],
		});

		const wb = rows.find((r) => r.service === "workflow-builder");
		expect(wb).toBeDefined();
		expect(wb?.envs.ryzen?.source).toBe("inventory");
		expect(wb?.envs.dev?.source).toBe("inventory");
		expect(wb?.envs.staging?.source).toBe("inventory");
		expect(wb?.envs.dev?.tag).toBe("git-11111111");
		expect(wb?.envs.dev?.commitSha).toBe("11111111");
	});

	it("mcp-gateway ryzen is null when no ryzen app exists", () => {
		const inventory = makeInventory({
			dev: [
				makeApp({
					name: "dev-mcp-gateway",
					component: "mcp-gateway",
					desired: { image: null, tag: "git-22222222", digest: null, commitSha: "22222222" },
				}),
			],
			staging: [
				makeApp({
					name: "staging-mcp-gateway",
					component: "mcp-gateway",
					desired: { image: null, tag: "git-22222222", digest: null, commitSha: "22222222" },
				}),
			],
		});

		const rows = buildServiceMatrix({
			inventory,
			releasePins: [makePin("mcp-gateway", "git-22222222")],
		});

		const gw = rows.find((r) => r.service === "mcp-gateway");
		expect(gw?.specialCase).toBe("ryzen-missing-pin");
		expect(gw?.envs.ryzen).toBeNull();
		expect(gw?.envs.dev?.source).toBe("inventory");
		expect(gw?.envs.staging?.source).toBe("inventory");
	});

	it("openshell-agent-runtime only has ryzen cell populated", () => {
		const inventory = makeInventory({
			ryzen: [
				makeApp({
					name: "ryzen-openshell-agent-runtime",
					component: "openshell-agent-runtime",
					desired: { image: null, tag: "git-33333333", digest: null, commitSha: "33333333" },
				}),
			],
		});

		const rows = buildServiceMatrix({ inventory, releasePins: [] });
		const svc = rows.find((r) => r.service === "openshell-agent-runtime");
		expect(svc?.specialCase).toBe("ryzen-only");
		expect(svc?.envs.ryzen?.source).toBe("inventory");
		expect(svc?.envs.dev).toBeNull();
		expect(svc?.envs.staging).toBeNull();
	});

	it("sandbox services use pin-only cells on dev and staging; ryzen is null", () => {
		const rows = buildServiceMatrix({
			inventory: null,
			releasePins: [makePin("openshell-sandbox", "git-44444444")],
		});
		const sb = rows.find((r) => r.service === "openshell-sandbox");
		expect(sb?.specialCase).toBe("sandbox-only");
		expect(sb?.envs.ryzen).toBeNull();
		expect(sb?.envs.dev?.source).toBe("pin-only");
		expect(sb?.envs.dev?.tag).toBe("git-44444444");
		expect(sb?.envs.staging?.source).toBe("pin-only");
	});

	it("agent-runtime-controller synthesises pin-only cells on all three envs when no inventory", () => {
		const rows = buildServiceMatrix({
			inventory: null,
			releasePins: [makePin("agent-runtime-controller", "git-55555555")],
		});
		const ctl = rows.find((r) => r.service === "agent-runtime-controller");
		expect(ctl?.specialCase).toBe("single-source");
		expect(ctl?.envs.ryzen?.source).toBe("pin-only");
		expect(ctl?.envs.dev?.source).toBe("pin-only");
		expect(ctl?.envs.staging?.source).toBe("pin-only");
		expect(ctl?.envs.staging?.tag).toBe("git-55555555");
	});

	it("inventory = null returns all 14 rows without crashing", () => {
		const rows = buildServiceMatrix({ inventory: null, releasePins: [] });
		expect(rows).toHaveLength(WB_SERVICES.length);
		// Services with no special fallback should have all null cells.
		const wb = rows.find((r) => r.service === "workflow-builder");
		expect(wb?.envs.ryzen).toBeNull();
		expect(wb?.envs.dev).toBeNull();
		expect(wb?.envs.staging).toBeNull();
	});

	it("falls back to release-pin on dev/staging when inventory lacks the service", () => {
		// Simulates the real-world gap: hub inventory only covers a subset of
		// services (e.g. workflow-mcp-server isn't indexed yet).
		const rows = buildServiceMatrix({
			inventory: makeInventory({ dev: [], staging: [] }),
			releasePins: [makePin("workflow-mcp-server", "git-66666666")],
		});
		const svc = rows.find((r) => r.service === "workflow-mcp-server");
		expect(svc?.envs.dev?.source).toBe("pin-only");
		expect(svc?.envs.dev?.tag).toBe("git-66666666");
		expect(svc?.envs.staging?.source).toBe("pin-only");
		expect(svc?.envs.ryzen).toBeNull();
	});

	it("falls back to live K8s on the current env for regular services", () => {
		// Simulates the ryzen case: hub inventory has no ryzen environment, but
		// we're running inside the ryzen pod and can see local Deployments.
		const rows = buildServiceMatrix({
			inventory: null,
			releasePins: [],
			live: [
				{
					name: "workflow-builder",
					namespace: "workflow-builder",
					labels: {},
					replicas: 1,
					readyReplicas: 1,
					availableReplicas: 1,
					updatedReplicas: 1,
					pods: { total: 1, running: 1, ready: 1, names: ["workflow-builder-abc"] },
					containers: [
						{
							image: "ghcr.io/pittampalliorg/workflow-builder:git-77777777",
							repository: "ghcr.io/pittampalliorg/workflow-builder",
							name: "workflow-builder",
							tag: "git-77777777",
							digest: null,
							commitSha: "77777777",
							containerName: "workflow-builder",
							imageID: null,
							ready: true,
							restartCount: 0,
							desiredTag: null,
							desiredCommitSha: null,
							desiredMatches: null,
							commit: null,
							pinKey: null,
						},
					],
				},
			],
			currentEnv: "ryzen",
		});
		const wb = rows.find((r) => r.service === "workflow-builder");
		expect(wb?.envs.ryzen?.source).toBe("live-only");
		expect(wb?.envs.ryzen?.tag).toBe("git-77777777");
		// No pin-only fallback on ryzen (ryzen uses gitea-ryzen kustomization, not release-pins).
		// Dev/staging remain null because pins aren't provided here.
		expect(wb?.envs.dev).toBeNull();
	});

	it("prefers inventory over pin when both exist", () => {
		const inventory = makeInventory({
			dev: [
				makeApp({
					name: "dev-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: "git-inventory", digest: null, commitSha: "inventor" },
				}),
			],
		});
		const rows = buildServiceMatrix({
			inventory,
			releasePins: [makePin("workflow-builder", "git-pinlater")],
		});
		const wb = rows.find((r) => r.service === "workflow-builder");
		expect(wb?.envs.dev?.tag).toBe("git-inventory");
		expect(wb?.envs.dev?.source).toBe("inventory");
	});
});

describe("summarizeMatrix", () => {
	it("counts drift, degraded, failed builds, and stuck promotions", () => {
		const degraded = makeApp({
			name: "staging-workflow-builder",
			component: "workflow-builder",
			live: {
				images: [],
				syncStatus: "OutOfSync",
				healthStatus: "Degraded",
			},
			build: {
				pipelineRun: "pr-broken",
				status: "False",
				reason: "Failed",
				startedAt: null,
				finishedAt: null,
			},
			promotion: { drySha: null, hydratedSha: null, healthPhase: "Failed" },
			drift: { status: "pending_rollout" },
		});

		const inventory = makeInventory({ staging: [degraded] });
		const rows = buildServiceMatrix({ inventory, releasePins: [] });
		const summary = summarizeMatrix(rows);

		expect(summary.driftCount).toBeGreaterThanOrEqual(1);
		expect(summary.failedBuilds).toBe(1);
		expect(summary.degradedApps).toBe(1);
		expect(summary.pendingPromotions).toBe(1);
	});

	it("is quiet when everything is healthy", () => {
		const inventory = makeInventory({
			dev: [
				makeApp({
					name: "dev-workflow-builder",
					component: "workflow-builder",
				}),
			],
		});
		const rows = buildServiceMatrix({ inventory, releasePins: [] });
		const summary = summarizeMatrix(rows);
		expect(summary.driftCount).toBe(0);
		expect(summary.failedBuilds).toBe(0);
		expect(summary.degradedApps).toBe(0);
		expect(summary.pendingPromotions).toBe(0);
	});
});
