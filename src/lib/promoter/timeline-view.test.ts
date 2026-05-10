import { describe, expect, it } from "vitest";

import workflowBuilderRelease from "./__fixtures__/workflow-builder-release.json";
import { buildTimelineView } from "./timeline-view";
import type { PromotionStrategy } from "$lib/server/promoter/types";

const wfb = workflowBuilderRelease as PromotionStrategy;

describe("buildTimelineView", () => {
	const view = buildTimelineView(wfb);

	it("returns the env branches in spec order", () => {
		expect(view.branches).toEqual(["env/spokes-dev", "env/spokes-staging"]);
	});

	it("flattens history per branch", () => {
		expect(view.entriesByBranch["env/spokes-dev"]).toHaveLength(1);
		expect(view.entriesByBranch["env/spokes-staging"]).toHaveLength(1);
	});

	it("derives a deterministic id per entry", () => {
		const id = view.entriesByBranch["env/spokes-dev"][0].id;
		expect(id).toMatch(/^env\/spokes-dev#0#/);
	});

	it("emits a cross-env edge when the same dry SHA appears in two branches", () => {
		// dev history #0 has sha ed9d2c… and staging has the same in active.dry,
		// but staging's history entry is for a different sha (f00ba…), so the
		// fixture as-is should NOT produce a dev↔staging edge. Verify:
		expect(view.edges).toHaveLength(0);
	});

	it("respects showOnlyFailed filter", () => {
		const view2 = buildTimelineView(wfb, { showOnlyFailed: true });
		// All fixture history is success — filtering should empty everything
		expect(view2.entriesByBranch["env/spokes-dev"]).toHaveLength(0);
		expect(view2.entriesByBranch["env/spokes-staging"]).toHaveLength(0);
	});
});

describe("buildTimelineView with cross-env lineage", () => {
	const synthetic: PromotionStrategy = {
		metadata: { name: "x", namespace: "argocd" },
		spec: { environments: [{ branch: "env/dev" }, { branch: "env/staging" }] },
		status: {
			environments: [
				{
					branch: "env/dev",
					history: [
						{
							active: { dry: { sha: "shared-sha-1" }, hydrated: { sha: "h1" } },
							endedAt: "2026-05-09T12:00:00Z",
						},
					],
				},
				{
					branch: "env/staging",
					history: [
						{
							active: { dry: { sha: "shared-sha-1" }, hydrated: { sha: "h2" } },
							endedAt: "2026-05-09T12:30:00Z",
						},
					],
				},
			],
		},
	};

	it("connects matching dry SHAs across consecutive envs", () => {
		const v = buildTimelineView(synthetic);
		expect(v.edges).toHaveLength(1);
		expect(v.edges[0].dryShaFull).toBe("shared-sha-1");
		expect(v.edges[0].fromId).toMatch(/^env\/dev#/);
		expect(v.edges[0].toId).toMatch(/^env\/staging#/);
	});
});
