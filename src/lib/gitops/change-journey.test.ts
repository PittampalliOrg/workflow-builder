import { describe, expect, it } from "vitest";

import {
	buildChangeJourneys,
	filterChangeJourneys,
	journeyGraphHighlight,
	type ChangeJourneyStepKind,
} from "./change-journey";
import type { PipelineModel, PipelineStage } from "./pipeline-types";
import type { DeploymentMetadataResponse, ImageVersion } from "$lib/types/deployment-metadata";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

const LINKS = {
	argoCdBase: "https://argocd.example",
	stacksRepo: "https://github.com/PittampalliOrg/stacks",
	workflowBuilderRepo: "https://github.com/PittampalliOrg/workflow-builder",
	tektonBase: "https://tekton.example",
};

function stage(overrides: Partial<PipelineStage>): PipelineStage {
	return {
		name: "workflow-builder::dev",
		warehouse: "workflow-builder",
		env: "dev",
		requestedFreight: [{ origin: "workflow-builder", sources: { direct: true } }],
		health: "Healthy",
		syncStatus: "Synced",
		promotionPhase: null,
		drift: null,
		desiredTag: "git-11111111",
		liveTag: "git-11111111",
		commitSha: "11111111",
		source: "inventory",
		updatedAt: "2026-06-05T12:08:00Z",
		controlFlow: false,
		dormant: false,
		deliveryMode: "promoter",
		awaitingReconcile: false,
		gate: null,
		promotion: null,
		...overrides,
	};
}

function model(stages: PipelineStage[] = []): PipelineModel {
	const warehouseNames = [...new Set(stages.map((s) => s.warehouse))];
	return {
		warehouses: warehouseNames.map((name) => ({
			name,
			kind: name === "release-pins" ? "bundle" : "service",
			subsystem: "test",
			subscriptions: [],
			reconciling: false,
			hasError: false,
			specialCase: null,
		})),
		stages,
		freights: [],
		warehouseColorMap: Object.fromEntries(warehouseNames.map((name) => [name, "#38bdf8"])),
		stageColorMap: Object.fromEntries(stages.map((s) => [s.name, "#38bdf8"])),
		subsystems: ["test"],
		warehousesBySubsystem: {},
		generatedAt: "2026-06-05T12:00:00Z",
	};
}

function metadata(imageHistory: ImageVersion[] = []): DeploymentMetadataResponse {
	return {
		generatedAt: "2026-06-05T12:00:00Z",
		environment: {
			name: "ryzen",
			namespace: "workflow-builder",
			appUrl: null,
			nodeEnv: null,
			podName: null,
		},
		gitops: {
			releasePinsSourceUrl: "",
			releasePinsFetchedAt: null,
			releasePinsError: null,
			stacksMain: null,
			desiredImages: [],
			imageHistory,
			imageHistoryError: null,
		},
		live: { deployments: [], error: null },
		inventory: { sourceUrl: null, fetchedAt: null, error: null, data: null },
	};
}

function imageVersion(overrides: Partial<ImageVersion> = {}): ImageVersion {
	return {
		service: "workflow-builder",
		tag: "git-11111111",
		digest: "sha256:abc",
		sourceSha: "11111111",
		committedAt: "2026-06-05T12:00:00Z",
		pinCommit: "22222222",
		pinCommittedAt: "2026-06-05T12:04:00Z",
		message: "ship workflow-builder",
		...overrides,
	};
}

function event(overrides: Partial<GitOpsActivityEvent> = {}): GitOpsActivityEvent {
	const source = overrides.source ?? "github";
	return {
		eventId: overrides.eventId ?? `evt-${Math.random()}`,
		sequence: overrides.sequence ?? 1,
		source,
		resourceRef: overrides.resourceRef ?? {
			group: source === "argocd" ? "argoproj.io" : null,
			version: null,
			resource: null,
			kind: null,
			namespace: null,
			name: null,
			uid: null,
		},
		activityKey: overrides.activityKey ?? "test",
		activityType: overrides.activityType ?? `github.push`,
		phase: overrides.phase ?? "done",
		reason: overrides.reason ?? null,
		message: overrides.message ?? null,
		observedAt: overrides.observedAt ?? "2026-06-05T12:00:00Z",
		correlation: overrides.correlation ?? {},
		raw: overrides.raw ?? {},
		createdAt: overrides.createdAt ?? "2026-06-05T12:00:00Z",
		updatedAt: overrides.updatedAt ?? "2026-06-05T12:00:00Z",
	};
}

function kinds(journey: { steps: { kind: ChangeJourneyStepKind }[] }): ChangeJourneyStepKind[] {
	return journey.steps.map((step) => step.kind);
}

describe("buildChangeJourneys", () => {
	it("groups a stacks PR opened -> merged -> ArgoCD sync path", () => {
		const journeys = buildChangeJourneys({
			events: [
				event({
					eventId: "pr-open",
					sequence: 1,
					activityType: "github.pull_request",
					phase: "opened",
					correlation: {
						repo: "PittampalliOrg/stacks",
						branch: "main",
						pullRequestNumber: 42,
						commitSha: "aaaaaaa111111",
						senderLogin: "vpittamp",
					},
				}),
				event({
					eventId: "pr-merged",
					sequence: 2,
					activityType: "github.pull_request",
					phase: "closed",
					observedAt: "2026-06-05T12:02:00Z",
					correlation: {
						repo: "PittampalliOrg/stacks",
						branch: "main",
						pullRequestNumber: 42,
						commitSha: "aaaaaaa111111",
						merged: true,
					},
				}),
				event({
					eventId: "argo-sync",
					sequence: 3,
					source: "argocd",
					activityType: "argocd.application",
					phase: "Healthy",
					observedAt: "2026-06-05T12:05:00Z",
					correlation: {
						repo: "PittampalliOrg/stacks",
						commitSha: "aaaaaaa111111",
						argocdApp: "ryzen-workflow-builder",
						syncStatus: "Synced",
						healthStatus: "Healthy",
					},
				}),
			],
			metadata: metadata(),
			model: model([
				stage({
					name: "workflow-builder::ryzen",
					env: "ryzen",
					deliveryMode: "direct-main",
				}),
			]),
			links: LINKS,
			viewerEmail: "vpittamp@example.com",
		});

		expect(journeys).toHaveLength(1);
		expect(journeys[0]).toMatchObject({
			repoLabel: "stacks",
			pullRequestNumber: "42",
			status: "done",
			isMine: true,
		});
		expect(kinds(journeys[0]!)).toEqual(["github-pr", "merge", "argocd-sync"]);
		expect(journeys[0]?.stageNames).toContain("workflow-builder::ryzen");
	});

	it("threads workflow-builder merge -> build -> pin -> dev promotion -> deploy", () => {
		const version = imageVersion();
		const journeys = buildChangeJourneys({
			events: [
				event({
					eventId: "push",
					activityType: "github.push",
					correlation: {
						repo: "PittampalliOrg/workflow-builder",
						branch: "main",
						commitSha: "11111111",
					},
				}),
			],
			metadata: metadata([version]),
			model: model([
				stage({
					name: "workflow-builder::dev",
					env: "dev",
					deliveryMode: "promoter",
					build: {
						pipelineRun: "outer-loop-workflow-builder-111",
						phase: "built",
						startedAt: "2026-06-05T12:01:00Z",
						finishedAt: "2026-06-05T12:03:00Z",
						durationMs: 120_000,
					},
					provenance: {
						commitSha: "11111111",
						commitMessage: "ship workflow-builder",
						committedAt: "2026-06-05T12:00:00Z",
						pinCommit: "22222222",
						pinCommittedAt: "2026-06-05T12:04:00Z",
					},
					promotion: {
						inFlight: false,
						proposedTag: null,
						activeTag: "hydrated333",
						activeAt: "2026-06-05T12:06:00Z",
						gates: [],
						soak: null,
						pullRequest: { url: "https://github.com/PittampalliOrg/stacks/pull/9", state: "merged" },
						stalledOn: null,
					},
				}),
			]),
			links: LINKS,
		});

		const journey = journeys[0]!;
		expect(journey.repoLabel).toBe("workflow-builder");
		expect(journey.services).toEqual(["workflow-builder"]);
		expect(journey.lanes).toContain("promoter-dev");
		expect(kinds(journey)).toEqual([
			"github-push",
			"build",
			"pin",
			"pin",
			"promote",
			"argocd-sync",
			"deploy",
		]);
		expect(journey.hasImageReplacement).toBe(true);
		expect(journey.status).toBe("done");
	});

	it("models a ryzen direct-main pin and sync without a Promoter step", () => {
		const version = imageVersion({ pinCommit: "ryzenpin1" });
		const journey = buildChangeJourneys({
			events: [],
			metadata: metadata([version]),
			model: model([
				stage({
					name: "workflow-builder::ryzen",
					env: "ryzen",
					deliveryMode: "direct-main",
					provenance: {
						commitSha: "11111111",
						commitMessage: null,
						committedAt: null,
						pinCommit: "ryzenpin1",
						pinCommittedAt: "2026-06-05T12:04:00Z",
					},
				}),
			]),
			links: LINKS,
		})[0]!;

		expect(journey.lanes).toEqual(["direct-ryzen"]);
		expect(journey.steps.some((step) => step.label.includes("Promoter"))).toBe(false);
		expect(journey.steps.some((step) => step.label === "Ryzen canary lane")).toBe(true);
		expect(journey.hasImageReplacement).toBe(true);
	});

	it("keeps a failed Tekton build visible even when it produced no pin or deploy", () => {
		const journey = buildChangeJourneys({
			events: [
				event({
					eventId: "failed-build",
					source: "tekton",
					activityType: "tekton.pipelinerun",
					phase: "Failed",
					reason: "Failed",
					correlation: {
						imageName: "workflow-builder",
						gitSha: "bbbbbbb222222",
						pipelineRun: "outer-loop-workflow-builder-failed",
					},
				}),
			],
			metadata: metadata(),
			model: model([stage({})]),
			links: LINKS,
		})[0]!;

		expect(journey.status).toBe("failed");
		expect(journey.hasFailure).toBe(true);
		expect(kinds(journey)).toEqual(["build"]);
	});

	it("marks a workflow-builder commit with no build evidence as skipped", () => {
		const journey = buildChangeJourneys({
			events: [
				event({
					eventId: "docs-push",
					activityType: "github.push",
					correlation: {
						repo: "PittampalliOrg/workflow-builder",
						branch: "main",
						commitSha: "ccccccc333333",
					},
				}),
			],
			metadata: metadata(),
			model: model(),
			links: LINKS,
		})[0]!;

		expect(journey.repoLabel).toBe("workflow-builder");
		expect(journey.steps.map((step) => [step.kind, step.state])).toEqual([
			["github-push", "done"],
			["build", "skipped"],
		]);
	});

	it("filters journeys and derives a graph highlight for selection", () => {
		const version = imageVersion();
		const journeys = buildChangeJourneys({
			events: [],
			metadata: metadata([version]),
			model: model([
				stage({
					name: "workflow-builder::dev",
					env: "dev",
					provenance: {
						commitSha: "11111111",
						commitMessage: null,
						committedAt: null,
						pinCommit: "22222222",
						pinCommittedAt: "2026-06-05T12:04:00Z",
					},
				}),
			]),
			links: LINKS,
		});

		expect(filterChangeJourneys(journeys, "images")).toHaveLength(1);
		expect(filterChangeJourneys(journeys, "promoter-dev")).toHaveLength(1);
		expect(filterChangeJourneys(journeys, "direct-ryzen")).toHaveLength(0);
		expect(journeyGraphHighlight(journeys[0]!)).toEqual({
			warehouse: "workflow-builder",
			stageNames: ["workflow-builder::dev"],
		});
	});
});

describe("change journey — dev-env-v2 lanes", () => {
	it("classifies a dev-images pin bump into the dev-images lane, not promoter-dev", () => {
		const journeys = buildChangeJourneys({
			events: [
				event({
					source: "github",
					activityType: "github.push",
					correlation: {
						repo: "PittampalliOrg/stacks",
						branch: "main",
						commitSha: "abc123",
						// checked before the substring branches — must NOT become promoter-dev.
						expectedGitOpsLane: "dev-images",
					},
				}),
			],
			metadata: metadata(),
			model: model(),
			links: LINKS,
		});

		expect(journeys).toHaveLength(1);
		expect(journeys[0]?.lanes).toContain("dev-images");
		expect(journeys[0]?.lanes).not.toContain("promoter-dev");
		expect(filterChangeJourneys(journeys, "dev-images")).toHaveLength(1);
		expect(filterChangeJourneys(journeys, "promoter-dev")).toHaveLength(0);
	});

	it("threads a pr-preview TaskRun onto the PR journey with a preview step", () => {
		const journeys = buildChangeJourneys({
			events: [
				event({
					eventId: "gh-pr",
					source: "github",
					activityType: "github.pull_request",
					correlation: {
						repo: "PittampalliOrg/workflow-builder",
						pullRequestNumber: "77",
						previewLabeled: true,
						expectedGitOpsLane: "pr-preview",
						pullRequestUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/77",
					},
				}),
				event({
					eventId: "tr-preview",
					source: "tekton",
					activityType: "tekton.taskrun",
					phase: "Running",
					resourceRef: {
						group: "tekton.dev",
						version: "v1",
						resource: "taskruns",
						kind: "TaskRun",
						namespace: "tekton-pipelines",
						name: "wfb-pr-preview-up-xyz",
						uid: "tr-uid",
					},
					correlation: {
						pullRequestNumber: "77",
						buildLoop: "pr-preview",
						taskRun: "wfb-pr-preview-up-xyz",
					},
				}),
			],
			metadata: metadata(),
			model: model(),
			links: LINKS,
		});

		// Both events group onto ONE PR journey (repo-agnostic PR key).
		expect(journeys).toHaveLength(1);
		const journey = journeys[0]!;
		expect(journey.lanes).toContain("pr-preview");
		expect(kinds(journey)).toContain("preview");
		expect(filterChangeJourneys(journeys, "pr-preview")).toHaveLength(1);
	});

	it("adds preview + verify steps from the prPreviews input", () => {
		const journeys = buildChangeJourneys({
			events: [
				event({
					eventId: "gh-pr",
					source: "github",
					activityType: "github.pull_request",
					correlation: {
						repo: "PittampalliOrg/workflow-builder",
						pullRequestNumber: "88",
						pullRequestUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/88",
					},
				}),
			],
			metadata: metadata(),
			model: model(),
			links: LINKS,
			prPreviews: [
				{
					prNumber: 88,
					alias: "pr-88",
					url: "https://wfb-pr-88.example",
					state: "ready",
					headSha: "deadbeef",
					services: ["workflow-builder"],
					error: null,
					verify: {
						state: "completed",
						executionId: "exec-1",
						reason: null,
						verdict: "all flows pass",
					},
					updatedAt: "2026-07-05T12:00:00Z",
					prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/88",
				},
			],
		});

		expect(journeys).toHaveLength(1);
		const journey = journeys[0]!;
		expect(journey.lanes).toContain("pr-preview");
		expect(kinds(journey)).toEqual(expect.arrayContaining(["preview", "verify"]));
		const previewStep = journey.steps.find((s) => s.kind === "preview");
		expect(previewStep?.state).toBe("done");
		expect(previewStep?.href).toBe("https://wfb-pr-88.example");
		const verifyStep = journey.steps.find((s) => s.kind === "verify");
		expect(verifyStep?.state).toBe("done");
	});

	it("shows an orphan preview (no PR events) as a synthetic pr-preview journey", () => {
		const journeys = buildChangeJourneys({
			events: [],
			metadata: metadata(),
			model: model(),
			links: LINKS,
			prPreviews: [
				{
					prNumber: 99,
					alias: "pr-99",
					url: null,
					state: "provisioning",
					headSha: null,
					services: [],
					error: null,
					verify: null,
					updatedAt: "2026-07-05T12:00:00Z",
					prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/99",
				},
			],
		});

		expect(filterChangeJourneys(journeys, "pr-preview")).toHaveLength(1);
		const journey = journeys[0]!;
		expect(kinds(journey)).toEqual(["preview"]);
		expect(journey.steps[0]?.state).toBe("active");
	});
});
