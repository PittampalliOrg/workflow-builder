import { describe, expect, it } from "vitest";

import type {
	FleetDriftExtras,
	GitCommitMetadata,
} from "$lib/types/deployment-metadata";

import {
	buildFleetServiceDrift,
	buildLineage,
	compactAgeLabel,
	compareToMainUrl,
	PIN_AGE_AMBER_MS,
	pinVsMainStatus,
	shasMatch,
	summarizeFleetDrift,
} from "./fleet-drift-view";
import type { EnvCell, ServiceRow } from "./service-matrix";

const REPO = "https://github.com/PittampalliOrg/workflow-builder";
const MAIN_SHA = "bd4dce2e39b69765a28520329cacebb70fecb335";
const OLD_SHA = "1111111a39b69765a28520329cacebb70fecb335";

function mainHead(sha = MAIN_SHA): GitCommitMetadata {
	return {
		sha,
		shortSha: sha.slice(0, 8),
		url: `${REPO}/commit/${sha}`,
		message: "head",
		authorName: null,
		committedAt: "2026-07-16T00:00:00Z",
	};
}

function cell(overrides: Partial<EnvCell> = {}): EnvCell {
	return {
		source: "inventory",
		tag: `git-${MAIN_SHA}`,
		digest: null,
		commitSha: MAIN_SHA,
		desiredImage: null,
		liveImage: null,
		syncStatus: "Synced",
		healthStatus: "Healthy",
		driftStatus: "in_sync",
		promotionHealth: null,
		hydratedSha: null,
		buildStatus: null,
		buildReason: null,
		buildPipelineRun: null,
		buildStartedAt: null,
		buildFinishedAt: null,
		updatedAt: "2026-07-16T01:00:00Z",
		applicationName: "dev-workflow-builder",
		ready: null,
		...overrides,
	};
}

function row(overrides: Partial<ServiceRow> = {}): ServiceRow {
	return {
		service: "workflow-builder",
		specialCase: null,
		envs: { ryzen: null, dev: cell(), staging: cell() },
		...overrides,
	};
}

function extras(overrides: Partial<FleetDriftExtras> = {}): FleetDriftExtras {
	return {
		generatedAt: "2026-07-17T00:00:00Z",
		workflowBuilderMainHead: mainHead(),
		stacksMainHead: null,
		pinAges: [
			{ service: "workflow-builder", updatedAt: "2026-07-16T12:00:00Z", ageMs: 3_600_000 },
		],
		newestBuilt: [
			{
				service: "workflow-builder",
				newestTag: `git-${MAIN_SHA}`,
				newestPinCommittedAt: "2026-07-16T12:00:00Z",
				inFlightPipelineRun: null,
			},
		],
		previewPlatform: {
			pinRevision: null,
			brokerImageDigest: null,
			releasePinsWorkflowBuilderDigest: null,
			skew: false,
		},
		liveDeployments: [],
		...overrides,
	};
}

describe("shasMatch / pinVsMainStatus", () => {
	it("matches prefix-tolerantly in both directions", () => {
		expect(shasMatch(MAIN_SHA.slice(0, 12), MAIN_SHA)).toBe(true);
		expect(shasMatch(MAIN_SHA, MAIN_SHA.slice(0, 12))).toBe(true);
		expect(shasMatch(OLD_SHA, MAIN_SHA)).toBe(false);
		// Too-short prefixes never match (avoid 4-char false positives).
		expect(shasMatch(MAIN_SHA.slice(0, 4), MAIN_SHA)).toBe(false);
		expect(shasMatch(null, MAIN_SHA)).toBe(false);
	});

	it("classifies pin vs main", () => {
		expect(pinVsMainStatus(MAIN_SHA, mainHead())).toBe("in-sync");
		expect(pinVsMainStatus(OLD_SHA, mainHead())).toBe("behind-main");
		expect(pinVsMainStatus(null, mainHead())).toBe("unknown");
		expect(pinVsMainStatus(MAIN_SHA, null)).toBe("unknown");
	});
});

describe("buildFleetServiceDrift", () => {
	it("joins pin ages, newest built, and behind-main with a compare link", () => {
		const rows = [
			row({
				envs: {
					ryzen: null,
					dev: cell({ tag: `git-${OLD_SHA}`, commitSha: OLD_SHA }),
					staging: cell({ tag: `git-${OLD_SHA}`, commitSha: OLD_SHA }),
				},
			}),
		];
		const drift = buildFleetServiceDrift(rows, extras(), {
			workflowBuilderRepoUrl: REPO,
			now: Date.parse("2026-07-17T00:00:00Z"),
		});
		const entry = drift.get("workflow-builder")!;
		expect(entry.pinVsMain).toBe("behind-main");
		expect(entry.compareUrl).toBe(`${REPO}/compare/${OLD_SHA}...main`);
		expect(entry.newestBuiltTag).toBe(`git-${MAIN_SHA}`);
		expect(entry.pinAgeMs).toBe(3_600_000);
		expect(entry.pinStale).toBe(false);
	});

	it("flags stale pins past the amber threshold and degrades without extras", () => {
		const stale = buildFleetServiceDrift(
			[row()],
			extras({
				pinAges: [
					{
						service: "workflow-builder",
						updatedAt: "2026-07-10T00:00:00Z",
						ageMs: PIN_AGE_AMBER_MS + 1,
					},
				],
			}),
			{ workflowBuilderRepoUrl: REPO },
		);
		expect(stale.get("workflow-builder")!.pinStale).toBe(true);

		const empty = buildFleetServiceDrift([row()], null, {
			workflowBuilderRepoUrl: REPO,
		});
		const entry = empty.get("workflow-builder")!;
		expect(entry.newestBuiltTag).toBeNull();
		expect(entry.pinAgeMs).toBeNull();
		expect(entry.pinVsMain).toBe("unknown");
		// Pin tag still resolves from the matrix row itself.
		expect(entry.pinTag).toBe(`git-${MAIN_SHA}`);
	});
});

describe("buildLineage", () => {
	it("builds built → pinned → deployed steps for visible envs", () => {
		const drift = buildFleetServiceDrift([row()], extras(), {
			workflowBuilderRepoUrl: REPO,
		});
		const steps = buildLineage(row(), drift.get("workflow-builder")!, [
			"dev",
			"staging",
		]);
		expect(steps.map((s) => s.id)).toEqual([
			"built",
			"pinned",
			"deployed-dev",
			"deployed-staging",
		]);
		expect(steps[0]!.state).toBe("done");
		expect(steps[1]!.detail).toBe("at main HEAD");
		expect(steps[2]!.state).toBe("done");
	});

	it("marks in-flight builds active and pending rollouts pending; sandboxes stop at pinned", () => {
		const withBuild = extras({
			newestBuilt: [
				{
					service: "workflow-builder",
					newestTag: `git-${MAIN_SHA}`,
					newestPinCommittedAt: null,
					inFlightPipelineRun: "outer-loop-workflow-builder-abc",
				},
			],
		});
		const pendingRow = row({
			envs: {
				ryzen: null,
				dev: cell({ syncStatus: "OutOfSync", driftStatus: "pending_rollout" }),
				staging: null,
			},
		});
		const drift = buildFleetServiceDrift([pendingRow], withBuild, {
			workflowBuilderRepoUrl: REPO,
		});
		const steps = buildLineage(pendingRow, drift.get("workflow-builder")!, [
			"dev",
			"staging",
		]);
		expect(steps[0]!.state).toBe("active");
		expect(steps.find((s) => s.id === "deployed-dev")!.state).toBe("pending");

		const sandbox = row({ service: "openshell-sandbox", specialCase: "sandbox-only" });
		expect(buildLineage(sandbox, null, ["dev", "staging"]).map((s) => s.id)).toEqual([
			"built",
			"pinned",
		]);
	});
});

describe("summaries and labels", () => {
	it("summarizes stale pins, behind-main, and in-flight builds", () => {
		const drift = new Map([
			[
				"a",
				{
					service: "a",
					newestBuiltTag: null,
					newestBuiltAt: null,
					inFlightPipelineRun: "run-1",
					pinTag: null,
					pinSha: null,
					pinUpdatedAt: null,
					pinAgeMs: PIN_AGE_AMBER_MS + 1,
					pinStale: true,
					pinVsMain: "behind-main" as const,
					compareUrl: null,
				},
			],
		]);
		expect(summarizeFleetDrift(drift)).toEqual({
			stalePins: 1,
			behindMain: 1,
			buildsInFlight: 1,
		});
	});

	it("renders compact ages", () => {
		expect(compactAgeLabel(null)).toBe("—");
		expect(compactAgeLabel(30_000)).toBe("<1m");
		expect(compactAgeLabel(5 * 60_000)).toBe("5m");
		expect(compactAgeLabel(3 * 3_600_000)).toBe("3h");
		expect(compactAgeLabel(50 * 3_600_000)).toBe("2d");
		expect(compareToMainUrl(REPO, null)).toBeNull();
	});
});
