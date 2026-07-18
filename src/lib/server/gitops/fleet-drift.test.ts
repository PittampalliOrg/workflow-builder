import { describe, expect, it } from "vitest";

import type { ReleasePinsSnapshot } from "$lib/server/dev-hub/github-sources";
import type {
	GitOpsInventoryEnvironment,
	ImageVersion,
} from "$lib/types/deployment-metadata";
import {
	buildDeploymentGenerations,
	buildFleetDriftExtras,
	buildNewestBuilt,
	buildPinAges,
	computeBrokerSkew,
} from "./fleet-drift";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function pins(overrides: Partial<ReleasePinsSnapshot> = {}): ReleasePinsSnapshot {
	return {
		fetchedAt: "2026-07-17T00:00:00.000Z",
		error: null,
		services: {
			"workflow-builder": {
				tag: "git-abc",
				digest: DIGEST_A,
				commitSha: "abc",
				updatedAt: "2026-07-16T00:00:00.000Z",
				pipelineRun: "build-wfb-1",
			},
		},
		...overrides,
	};
}

describe("computeBrokerSkew", () => {
	it("is false when either digest is unknown", () => {
		expect(computeBrokerSkew(null, DIGEST_A)).toBe(false);
		expect(computeBrokerSkew(DIGEST_A, null)).toBe(false);
		expect(computeBrokerSkew(null, null)).toBe(false);
	});
	it("is false when the digests match (case-insensitive)", () => {
		expect(computeBrokerSkew(DIGEST_A, DIGEST_A.toUpperCase())).toBe(false);
	});
	it("is true only when both digests are known and differ", () => {
		expect(computeBrokerSkew(DIGEST_A, DIGEST_B)).toBe(true);
	});
});

describe("buildPinAges", () => {
	it("computes the age from updatedAt", () => {
		const now = new Date("2026-07-17T00:00:00.000Z").getTime();
		expect(buildPinAges(pins(), now)).toEqual([
			{
				service: "workflow-builder",
				updatedAt: "2026-07-16T00:00:00.000Z",
				ageMs: 24 * 60 * 60_000,
			},
		]);
	});
	it("returns a null age when updatedAt is missing or garbage", () => {
		const snapshot = pins({
			services: {
				a: { tag: "t", digest: null, commitSha: null, updatedAt: null, pipelineRun: null },
				b: { tag: "t", digest: null, commitSha: null, updatedAt: "not-a-date", pipelineRun: null },
			},
		});
		expect(buildPinAges(snapshot, Date.now()).map((p) => p.ageMs)).toEqual([
			null,
			null,
		]);
	});
});

describe("buildNewestBuilt", () => {
	const history: ImageVersion[] = [
		{
			service: "workflow-builder",
			tag: "git-newest",
			digest: DIGEST_A,
			sourceSha: "newest",
			committedAt: "2026-07-16T10:00:00Z",
			pinCommit: "pin2",
			pinCommittedAt: "2026-07-16T10:05:00Z",
			message: "bump",
		},
		{
			service: "workflow-builder",
			tag: "git-older",
			digest: DIGEST_B,
			sourceSha: "older",
			committedAt: "2026-07-15T10:00:00Z",
			pinCommit: "pin1",
			pinCommittedAt: "2026-07-15T10:05:00Z",
			message: "bump",
		},
	];
	const inventory: GitOpsInventoryEnvironment[] = [
		{
			name: "dev",
			applications: [
				{
					name: "dev-workflow-builder",
					component: "workflow-builder",
					desired: { image: null, tag: null, digest: null, commitSha: null },
					live: { images: [], syncStatus: null, healthStatus: null },
					promotion: null,
					build: {
						pipelineRun: "build-wfb-running",
						status: "Running",
						reason: null,
						startedAt: "2026-07-17T00:00:00Z",
						finishedAt: null,
					},
					provenance: null,
					drift: { status: "in_sync" },
				},
				{
					name: "dev-sandbox-api",
					component: "sandbox-execution-api",
					desired: { image: null, tag: null, digest: null, commitSha: null },
					live: { images: [], syncStatus: null, healthStatus: null },
					promotion: null,
					build: {
						pipelineRun: "build-sea-done",
						status: "Succeeded",
						reason: null,
						startedAt: "2026-07-16T00:00:00Z",
						finishedAt: "2026-07-16T00:10:00Z",
					},
					provenance: null,
					drift: { status: "in_sync" },
				},
			],
		},
	];

	it("keeps the newest history tag per service and flags in-flight builds", () => {
		expect(buildNewestBuilt(history, inventory)).toEqual([
			{
				service: "workflow-builder",
				newestTag: "git-newest",
				newestPinCommittedAt: "2026-07-16T10:05:00Z",
				inFlightPipelineRun: "build-wfb-running",
			},
		]);
	});

	it("emits a row for a service that only has an in-flight build", () => {
		const rows = buildNewestBuilt([], inventory);
		expect(rows).toEqual([
			{
				service: "workflow-builder",
				newestTag: null,
				newestPinCommittedAt: null,
				inFlightPipelineRun: "build-wfb-running",
			},
		]);
	});
});

describe("buildDeploymentGenerations", () => {
	it("computes convergence from generation vs observedGeneration", () => {
		expect(
			buildDeploymentGenerations([
				{
					metadata: { name: "workflow-builder", generation: 4 },
					status: { observedGeneration: 4 },
				},
				{
					metadata: { name: "rolling", generation: 5 },
					status: { observedGeneration: 4 },
				},
				{ metadata: { name: "no-status", generation: 2 }, status: {} },
			]),
		).toEqual([
			{ name: "no-status", generation: 2, observedGeneration: null, converged: null },
			{ name: "rolling", generation: 5, observedGeneration: 4, converged: false },
			{ name: "workflow-builder", generation: 4, observedGeneration: 4, converged: true },
		]);
	});
});

describe("buildFleetDriftExtras", () => {
	it("assembles the DTO including the broker-skew datum", () => {
		const extras = buildFleetDriftExtras({
			pins: pins(),
			imageHistory: [],
			inventoryEnvironments: [],
			workflowBuilderMainHead: null,
			stacksMainHead: null,
			broker: { fetchedAt: null, error: null, digest: DIGEST_B },
			previewPinRevision: "65c3c799",
			deployments: [],
			now: new Date("2026-07-17T00:00:00.000Z").getTime(),
		});
		expect(extras.previewPlatform).toEqual({
			pinRevision: "65c3c799",
			brokerImageDigest: DIGEST_B,
			releasePinsWorkflowBuilderDigest: DIGEST_A,
			skew: true,
		});
		expect(extras.generatedAt).toBe("2026-07-17T00:00:00.000Z");
	});
});
