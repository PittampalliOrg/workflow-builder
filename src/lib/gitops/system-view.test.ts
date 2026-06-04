import { describe, expect, it } from "vitest";

import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
import type {
	DeploymentMetadataResponse,
	GitOpsInventoryApplication,
} from "$lib/types/deployment-metadata";

import { buildGitopsSystemViewModel } from "./system-view";

function makeApp(overrides: Partial<GitOpsInventoryApplication>): GitOpsInventoryApplication {
	return {
		name: overrides.name ?? "dev-workflow-builder",
		component: overrides.component ?? "workflow-builder",
		desired: {
			image: "ghcr.io/pittampalliorg/workflow-builder:git-11111111",
			tag: "git-11111111",
			digest: "sha256:111",
			commitSha: "11111111",
			...(overrides.desired ?? {}),
		},
		live: {
			images: ["ghcr.io/pittampalliorg/workflow-builder:git-11111111"],
			syncStatus: "Synced",
			healthStatus: "Healthy",
			...(overrides.live ?? {}),
		},
		promotion: overrides.promotion ?? {
			drySha: "aaaa",
			hydratedSha: "bbbb",
			healthPhase: "Succeeded",
		},
		build: overrides.build ?? {
			pipelineRun: "outer-loop-old",
			status: "True",
			reason: "Succeeded",
			startedAt: "2026-06-04T12:00:00Z",
			finishedAt: "2026-06-04T12:04:00Z",
		},
		provenance: overrides.provenance ?? null,
		drift: overrides.drift ?? { status: "in_sync" },
	};
}

function makeMetadata(): DeploymentMetadataResponse {
	return {
		generatedAt: "2026-06-04T12:10:00Z",
		environment: {
			name: "ryzen",
			namespace: "workflow-builder",
			appUrl: "https://workflow-builder-ryzen.tail286401.ts.net",
			nodeEnv: "production",
			podName: "workflow-builder-abc",
			detectedFrom: "appUrl",
		},
		gitops: {
			releasePinsSourceUrl:
				"https://raw.githubusercontent.com/PittampalliOrg/stacks/main/pins.yaml",
			releasePinsFetchedAt: "2026-06-04T12:09:00Z",
			releasePinsError: null,
			stacksMain: null,
			desiredImages: [
				{
					name: "workflow-builder",
					tag: "git-11111111",
					commitSha: "11111111",
					commit: null,
					imageRef: "ghcr.io/pittampalliorg/workflow-builder:git-11111111",
					digest: "sha256:111",
					sourceSha: "11111111",
					pipelineRun: "outer-loop-new",
					updatedAt: "2026-06-04T12:08:30Z",
				},
			],
		},
		live: {
			deployments: [
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
							containerName: "workflow-builder",
							imageID: null,
							ready: true,
							restartCount: 0,
							desiredTag: "git-11111111",
							desiredCommitSha: "11111111",
							desiredMatches: true,
							commit: null,
							pinKey: "workflow-builder",
							image: "ghcr.io/pittampalliorg/workflow-builder:git-11111111",
							repository: "ghcr.io/pittampalliorg/workflow-builder",
							name: "workflow-builder",
							tag: "git-11111111",
							digest: null,
							commitSha: "11111111",
						},
					],
				},
			],
			error: null,
		},
		inventory: {
			sourceUrl: "https://gitops-inventory-hub.tail286401.ts.net/inventory.json",
			fetchedAt: "2026-06-04T12:09:30Z",
			error: null,
			data: {
				generatedAt: "2026-06-04T12:09:20Z",
				source: "test",
				releasePins: { images: {}, error: null },
				environments: [
					{
						name: "ryzen",
						applications: [
							makeApp({
								name: "root-ryzen",
								component: "root",
								desired: { image: null, tag: null, digest: null, commitSha: null },
								live: { images: [], syncStatus: "Synced", healthStatus: "Healthy" },
								build: null,
							}),
							makeApp({ name: "ryzen-workflow-builder" }),
						],
					},
					{
						name: "dev",
						applications: [
							makeApp({
								name: "dev-workflow-builder",
								build: {
									pipelineRun: "outer-loop-new",
									status: "True",
									reason: "Succeeded",
									startedAt: "2026-06-04T12:05:00Z",
									finishedAt: "2026-06-04T12:08:00Z",
								},
							}),
						],
					},
				],
			},
		},
	};
}

function makePromotions(): PromotionStrategiesResponse {
	return {
		generatedAt: "2026-06-04T12:09:20Z",
		source: "hub-inventory",
		error: null,
		changeTransferPolicies: [],
		pullRequests: [],
		commitStatuses: [],
		strategies: [
			{
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
								dry: {
									sha: "22222222aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
									repoURL: "https://github.com/PittampalliOrg/stacks",
									commitTime: "2026-06-04T12:07:00Z",
								},
								hydrated: { sha: "33333333bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
								commitStatuses: [
									{ key: "argocd-health", phase: "success" },
									{ key: "timer", phase: "success" },
								],
							},
						},
					],
				},
			},
		],
	};
}

describe("buildGitopsSystemViewModel", () => {
	it("derives the active workflow-builder system lane state", () => {
		const view = buildGitopsSystemViewModel(makeMetadata(), makePromotions());

		expect(view.currentEnvironment).toBe("ryzen");
		expect(view.currentWorkflowBuilderLive?.tag).toBe("git-11111111");
		expect(view.activeWorkflowBuilderPin?.tag).toBe("git-11111111");
		expect(view.activeWorkflowBuilderPin?.digest).toBe("sha256:111");
		expect(view.activeWorkflowBuilderPin?.pipelineRun).toBe("outer-loop-new");
		expect(view.rootRyzen?.syncStatus).toBe("Synced");
		expect(view.ryzenWorkflowBuilder?.healthStatus).toBe("Healthy");
		expect(view.devWorkflowBuilder?.name).toBe("dev-workflow-builder");
		expect(view.latestOuterLoopBuild?.pipelineRun).toBe("outer-loop-new");
		expect(view.workflowBuilderRelease?.activeBranch).toBe("env/spokes-dev");
		expect(view.workflowBuilderSoak?.phase).toBe("success");
		expect(view.stagingDormant).toBe(true);
		expect(view.errors).toEqual([]);
	});
});
