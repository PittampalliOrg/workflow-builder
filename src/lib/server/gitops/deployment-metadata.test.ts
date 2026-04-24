import { describe, expect, it } from "vitest";

import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
import { toRuntimeMetadata } from "./deployment-metadata";

function baseMetadata(
	overrides: Partial<DeploymentMetadataResponse> = {},
): DeploymentMetadataResponse {
	return {
		generatedAt: "2026-04-24T14:00:00Z",
		environment: {
			name: "ryzen",
			namespace: "workflow-builder",
			appUrl: "https://workflow-builder-ryzen.tail286401.ts.net",
			nodeEnv: "production",
			podName: "workflow-builder-abc",
			detectedFrom: "env:WORKFLOW_BUILDER_ENV",
		},
		gitops: {
			releasePinsSourceUrl: "https://example.test/pins.yaml",
			releasePinsFetchedAt: null,
			releasePinsError: null,
			stacksMain: null,
			desiredImages: [],
		},
		live: {
			error: null,
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
							image:
								"gitea-ryzen.tail286401.ts.net/giteaadmin/workflow-builder:git-1234567890abcdef",
							repository:
								"gitea-ryzen.tail286401.ts.net/giteaadmin/workflow-builder",
							name: "workflow-builder",
							tag: "git-1234567890abcdef",
							digest: null,
							commitSha: "1234567890abcdef",
							imageID: "sha256:aaaaaaaaaaaa",
							ready: true,
							restartCount: 0,
							desiredTag: null,
							desiredCommitSha: null,
							desiredMatches: null,
							commit: {
								sha: "1234567890abcdef",
								shortSha: "12345678",
								url: "https://github.com/PittampalliOrg/workflow-builder/commit/1234567890abcdef",
								message: "Add runtime badge",
								authorName: "vpittamp",
								committedAt: "2026-04-24T13:00:00Z",
							},
							pinKey: null,
						},
					],
				},
			],
		},
		inventory: {
			sourceUrl: null,
			fetchedAt: null,
			error: null,
			data: null,
		},
		...overrides,
	};
}

describe("toRuntimeMetadata", () => {
	it("summarizes the current workflow-builder container", () => {
		const runtime = toRuntimeMetadata(baseMetadata());

		expect(runtime.environment.name).toBe("ryzen");
		expect(runtime.environment.detectedFrom).toBe("env:WORKFLOW_BUILDER_ENV");
		expect(runtime.current).toMatchObject({
			deploymentName: "workflow-builder",
			containerName: "workflow-builder",
			tag: "git-1234567890abcdef",
			commitSha: "1234567890abcdef",
			commitMessage: "Add runtime badge",
			ready: true,
		});
	});

	it("synthesizes a current environment matrix row when hub inventory lacks it", () => {
		const runtime = toRuntimeMetadata(baseMetadata());

		expect(runtime.matrix).toHaveLength(1);
		expect(runtime.matrix[0]).toMatchObject({
			environment: "ryzen",
			component: "workflow-builder",
			liveTag: "git-1234567890abcdef",
			liveCommitSha: "1234567890abcdef",
			driftStatus: "local_live",
		});
	});

	it("uses hub inventory rows for dev and keeps non-fatal errors", () => {
		const runtime = toRuntimeMetadata(
			baseMetadata({
				environment: {
					name: "dev",
					namespace: "workflow-builder",
					appUrl: "https://workflow-builder-dev.tail286401.ts.net",
					nodeEnv: "production",
					podName: "workflow-builder-abc",
					detectedFrom: "appUrl",
				},
				inventory: {
					sourceUrl: "https://gitops-inventory-hub.tail286401.ts.net/inventory.json",
					fetchedAt: "2026-04-24T14:00:00Z",
					error: "inventory timeout",
					data: {
						generatedAt: "2026-04-24T13:59:00Z",
						source: "hub",
						releasePins: { images: {}, error: null },
						environments: [
							{
								name: "dev",
								applications: [
									{
										name: "dev-workflow-builder",
										component: "workflow-builder",
										desired: {
											image:
												"ghcr.io/pittampalliorg/workflow-builder:git-abcdef1234567890",
											tag: "git-abcdef1234567890",
											digest: null,
											commitSha: "abcdef1234567890",
										},
										live: {
											images: [
												"ghcr.io/dapr/daprd:1.17.5",
												"ghcr.io/pittampalliorg/workflow-builder:git-abcdef1234567890",
											],
											syncStatus: "Synced",
											healthStatus: "Healthy",
										},
										promotion: {
											drySha: "dry",
											hydratedSha: "hydrated",
											healthPhase: "success",
										},
										build: {
											pipelineRun: "outer-loop-workflow-builder",
											status: "True",
											reason: "Succeeded",
											startedAt: "2026-04-24T13:00:00Z",
											finishedAt: "2026-04-24T13:05:00Z",
										},
										provenance: null,
										drift: { status: "in_sync" },
									},
								],
							},
						],
					},
				},
			}),
		);

		expect(runtime.matrix).toHaveLength(1);
		expect(runtime.matrix[0]).toMatchObject({
			environment: "dev",
			desiredTag: "git-abcdef1234567890",
			liveTag: "git-abcdef1234567890",
			promotionHealth: "success",
			buildReason: "Succeeded",
		});
		expect(runtime.errors).toEqual(["inventory timeout"]);
	});
});
