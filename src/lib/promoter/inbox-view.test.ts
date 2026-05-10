import { describe, expect, it } from "vitest";

import workflowBuilderRelease from "./__fixtures__/workflow-builder-release.json";
import stacksEnvironments from "./__fixtures__/stacks-environments.json";
import { buildInboxRow, buildInboxRows, sortInboxRows } from "./inbox-view";
import type { PromotionStrategy } from "$lib/server/promoter/types";

const wfb = workflowBuilderRelease as PromotionStrategy;
const stacks = stacksEnvironments as PromotionStrategy;

describe("buildInboxRow (workflow-builder-release fixture)", () => {
	const row = buildInboxRow(wfb);

	it("derives the strategy name + namespace", () => {
		expect(row.name).toBe("workflow-builder-release");
		expect(row.namespace).toBe("argocd");
	});

	it("phase is pending when staging has pending proposed checks", () => {
		expect(row.phase).toBe("pending");
	});

	it("populates stuckOn with the staging branch and pending check keys", () => {
		expect(row.stuckOn?.branch).toBe("env/spokes-staging");
		expect(row.stuckOn?.pendingChecks).toEqual(["argocd-health", "timer"]);
		expect(row.stuckOn?.failingChecks).toEqual([]);
	});

	it("populates the latest dry SHA short form", () => {
		expect(row.latestDryShaShort).toMatch(/^abc12345$/);
	});
});

describe("buildInboxRows + sortInboxRows", () => {
	const rows = buildInboxRows([stacks, wfb]);

	it("returns one row per strategy", () => {
		expect(rows).toHaveLength(2);
	});

	it("sortInboxRows by phase puts pending before healthy", () => {
		const sorted = sortInboxRows(rows, "phase", "asc");
		expect(sorted[0].name).toBe("workflow-builder-release"); // pending
		expect(sorted[1].name).toBe("stacks-environments"); // healthy
	});

	it("sortInboxRows by name asc is alphabetical", () => {
		const sorted = sortInboxRows(rows, "name", "asc");
		expect(sorted.map((r) => r.name)).toEqual([
			"stacks-environments",
			"workflow-builder-release",
		]);
	});
});

describe("buildInboxRow tail-most env active.pending (soak in flight)", () => {
	const stagingSoak: PromotionStrategy = {
		metadata: { name: "wfb", namespace: "argocd" },
		spec: { environments: [{ branch: "env/spokes-dev" }, { branch: "env/spokes-staging" }] },
		status: {
			environments: [
				{
					branch: "env/spokes-dev",
					active: {
						dry: { sha: "abc1234" },
						commitStatuses: [
							{ key: "argocd-health", phase: "success" },
							{ key: "timer", phase: "success" },
						],
					},
				},
				{
					branch: "env/spokes-staging",
					active: {
						dry: { sha: "abc1234" },
						commitStatuses: [
							{ key: "argocd-health", phase: "success" },
							{ key: "timer", phase: "pending" },
						],
					},
				},
			],
		},
	};

	it("phase is pending (not healthy) while staging timer is still soaking", () => {
		const row = buildInboxRow(stagingSoak);
		expect(row.phase).toBe("pending");
		expect(row.stuckOn?.branch).toBe("env/spokes-staging");
		expect(row.stuckOn?.pendingChecks).toEqual(["timer"]);
		expect(row.stuckOn?.failingChecks).toEqual([]);
	});
});

describe("buildInboxRow stuck on failure", () => {
	const failed: PromotionStrategy = {
		metadata: { name: "demo", namespace: "argocd" },
		spec: { environments: [{ branch: "env/dev" }, { branch: "env/staging" }] },
		status: {
			environments: [
				{
					branch: "env/dev",
					active: {
						dry: { sha: "abc" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
				},
				{
					branch: "env/staging",
					active: {
						dry: { sha: "def" },
						commitStatuses: [{ key: "argocd-health", phase: "success" }],
					},
					proposed: {
						dry: { sha: "abc" },
						commitStatuses: [
							{ key: "argocd-health", phase: "failure" },
							{ key: "timer", phase: "pending" },
						],
					},
				},
			],
		},
	};

	it("returns failure phase and lists the failing check keys", () => {
		const row = buildInboxRow(failed);
		expect(row.phase).toBe("failure");
		expect(row.stuckOn?.failingChecks).toEqual(["argocd-health"]);
		expect(row.stuckOn?.pendingChecks).toEqual(["timer"]);
	});
});
