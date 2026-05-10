import { describe, expect, it } from "vitest";

import workflowBuilderRelease from "./__fixtures__/workflow-builder-release.json";
import stacksEnvironments from "./__fixtures__/stacks-environments.json";
import { buildPipelineView, summarizeChecks } from "./pipeline-view";
import type { PromotionStrategy } from "$lib/server/promoter/types";

const wfb = workflowBuilderRelease as PromotionStrategy;
const stacks = stacksEnvironments as PromotionStrategy;

describe("summarizeChecks", () => {
	it("counts each phase", () => {
		expect(
			summarizeChecks([
				{ key: "argocd-health", phase: "success" },
				{ key: "timer", phase: "pending" },
				{ key: "lint", phase: "failure" },
				{ key: "extra", phase: "pending" },
			]),
		).toEqual({ total: 4, success: 1, pending: 2, failure: 1 });
	});

	it("returns zeros for empty input", () => {
		expect(summarizeChecks(undefined)).toEqual({ total: 0, success: 0, pending: 0, failure: 0 });
	});
});

describe("buildPipelineView (workflow-builder-release fixture)", () => {
	const view = buildPipelineView(wfb);

	it("emits one card per spec environment", () => {
		expect(view.envs).toHaveLength(2);
		expect(view.envs[0].branch).toBe("env/spokes-dev");
		expect(view.envs[1].branch).toBe("env/spokes-staging");
	});

	it("dev card has matching active and proposed dry SHAs (no proposed pane)", () => {
		const dev = view.envs[0];
		expect(dev.proposed).toBeNull();
		expect(dev.active.dry?.sha).toMatch(/^abc12345/);
		expect(dev.active.checks).toEqual({ total: 2, success: 2, pending: 0, failure: 0 });
	});

	it("staging card has a proposed pane with pending checks (mid-soak)", () => {
		const stg = view.envs[1];
		expect(stg.proposed).not.toBeNull();
		expect(stg.proposed?.dry?.sha).toMatch(/^abc12345/);
		expect(stg.proposed?.checks).toEqual({ total: 2, success: 0, pending: 2, failure: 0 });
		expect(stg.active.checks).toEqual({ total: 2, success: 2, pending: 0, failure: 0 });
	});

	it("overall phase is pending while staging has pending proposed checks", () => {
		expect(view.overallPhase).toBe("pending");
	});

	it("history is preserved per env", () => {
		expect(view.envs[0].history).toHaveLength(1);
		expect(view.envs[1].history).toHaveLength(1);
	});

	it("propagates gitRepositoryRef.name", () => {
		expect(view.gitRepositoryName).toBe("stacks");
	});
});

describe("buildPipelineView (stacks-environments fixture)", () => {
	const view = buildPipelineView(stacks);

	it("renders the single hub-control-plane env without a proposed pane", () => {
		expect(view.envs).toHaveLength(1);
		expect(view.envs[0].branch).toBe("env/hub");
		expect(view.envs[0].proposed).toBeNull();
	});

	it("overall phase is healthy when no env has pending or failed checks", () => {
		expect(view.overallPhase).toBe("healthy");
	});
});

describe("buildPipelineView with proposed checks", () => {
	const fakeStrategy: PromotionStrategy = {
		metadata: { name: "fake", namespace: "ns" },
		spec: { environments: [{ branch: "env/x" }] },
		status: {
			environments: [
				{
					branch: "env/x",
					active: {
						dry: { sha: "111" },
						hydrated: { sha: "aaa" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
					proposed: {
						dry: { sha: "222" },
						hydrated: { sha: "bbb" },
						commitStatuses: [
							{ key: "argocd-health", phase: "failure" },
							{ key: "timer", phase: "pending" },
						],
					},
				},
			],
		},
	};

	it("flags overallPhase as failure when a proposed check failed", () => {
		const v = buildPipelineView(fakeStrategy);
		expect(v.overallPhase).toBe("failure");
		expect(v.envs[0].proposed?.checks.failure).toBe(1);
	});
});
