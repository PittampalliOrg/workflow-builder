import { describe, expect, it } from "vitest";

import type {
	PromotionStrategiesResponse,
	PromotionStrategy,
	PullRequest,
} from "$lib/server/promoter/types";

import { buildPromotionPulse, shortBranchName } from "./promotion-pulse";

const STACKS = "https://github.com/PittampalliOrg/stacks";

function strategy(overrides: Partial<PromotionStrategy> = {}): PromotionStrategy {
	return {
		metadata: { name: "workflow-builder-images", namespace: "promoter" },
		spec: {
			environments: [{ branch: "env/spokes-dev" }, { branch: "env/spokes-staging" }],
		},
		status: {
			environments: [
				{
					branch: "env/spokes-dev",
					active: {
						dry: { sha: "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
				},
				{
					branch: "env/spokes-staging",
					active: {
						dry: { sha: "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
				},
			],
		},
		...overrides,
	};
}

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		metadata: { name: "pr-1", namespace: "promoter" },
		spec: {
			sourceBranch: "env/spokes-dev-next",
			targetBranch: "env/spokes-dev",
			title: "Promote workflow-builder",
			state: "open",
		},
		status: { id: 4321 },
		...overrides,
	};
}

function response(
	overrides: Partial<PromotionStrategiesResponse> = {},
): PromotionStrategiesResponse {
	return {
		generatedAt: "2026-07-17T00:00:00Z",
		source: "hub-inventory",
		strategies: [strategy()],
		changeTransferPolicies: [],
		pullRequests: [],
		commitStatuses: [],
		error: null,
		...overrides,
	};
}

describe("buildPromotionPulse", () => {
	it("builds one row per strategy with per-env phases and branch links", () => {
		const pulse = buildPromotionPulse(response(), { stacksRepoUrl: STACKS });
		expect(pulse.rows).toHaveLength(1);
		const row = pulse.rows[0]!;
		expect(row.phase).toBe("success");
		expect(row.envs.map((env) => env.shortBranch)).toEqual(["dev", "staging"]);
		expect(row.envs[0]!.branchUrl).toBe(`${STACKS}/tree/env/spokes-dev`);
		expect(pulse.totals.success).toBe(2);
	});

	it("marks an env pending + in-flight and linkifies its promotion PR", () => {
		const inFlight = strategy({
			status: {
				environments: [
					{
						branch: "env/spokes-dev",
						active: { dry: { sha: "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1" } },
						proposed: {
							dry: { sha: "bbbb222bbbb222bbbb222bbbb222bbbb222bbbb2" },
							commitStatuses: [{ key: "checks", phase: "pending" }],
						},
					},
					{
						branch: "env/spokes-staging",
						active: { dry: { sha: "aaaa111aaaa111aaaa111aaaa111aaaa111aaaa1" } },
					},
				],
			},
		});
		const pulse = buildPromotionPulse(
			response({ strategies: [inFlight], pullRequests: [pullRequest()] }),
			{ stacksRepoUrl: STACKS },
		);
		const dev = pulse.rows[0]!.envs[0]!;
		expect(dev.inFlight).toBe(true);
		expect(dev.phase).toBe("pending");
		expect(dev.prNumber).toBe(4321);
		expect(dev.prUrl).toBe(`${STACKS}/pull/4321`);
		expect(pulse.rows[0]!.phase).toBe("pending");
	});

	it("lists open PRs and counts change transfer policies", () => {
		const pulse = buildPromotionPulse(
			response({
				pullRequests: [
					pullRequest(),
					pullRequest({
						metadata: { name: "pr-2", namespace: "promoter" },
						spec: {
							sourceBranch: "x",
							targetBranch: "y",
							state: "merged",
						},
						status: { id: 9 },
					}),
				],
				changeTransferPolicies: [
					{ metadata: { name: "ctp-1", namespace: "promoter" } },
				],
			}),
			{ stacksRepoUrl: STACKS },
		);
		expect(pulse.openPrs).toHaveLength(1);
		expect(pulse.openPrs[0]!.url).toBe(`${STACKS}/pull/4321`);
		expect(pulse.changeTransferPolicyCount).toBe(1);
	});

	it("shortens env branch names", () => {
		expect(shortBranchName("env/spokes-dev")).toBe("dev");
		expect(shortBranchName("env/hub")).toBe("hub");
		expect(shortBranchName("main")).toBe("main");
	});
});
