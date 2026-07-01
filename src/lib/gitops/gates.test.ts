import { describe, expect, it } from "vitest";

import { argoGates, isPromotionPassing, releasePrGate, STAGING_SOAK_MS } from "./gates";
import type { EnvCell } from "./service-matrix";

function cell(overrides: Partial<EnvCell> = {}): EnvCell {
	return {
		source: "inventory",
		tag: null,
		digest: null,
		commitSha: null,
		desiredImage: null,
		liveImage: null,
		syncStatus: null,
		healthStatus: null,
		driftStatus: null,
		promotionHealth: null,
		hydratedSha: null,
		buildStatus: null,
		buildReason: null,
		buildPipelineRun: null,
		buildStartedAt: null,
		buildFinishedAt: null,
		updatedAt: null,
		applicationName: null,
		ready: null,
		...overrides,
	};
}

describe("isPromotionPassing", () => {
	it("accepts both TitleCase ArgoCD and lowercase hub-inventory success states", () => {
		for (const s of ["Succeeded", "Healthy", "succeeded", "healthy", "success", "True"]) {
			expect(isPromotionPassing(s)).toBe(true);
		}
	});

	it("rejects failure and unknown states", () => {
		for (const s of ["Failed", "Degraded", "Unknown", "", "Progressing"]) {
			expect(isPromotionPassing(s)).toBe(false);
		}
		expect(isPromotionPassing(null)).toBe(false);
		expect(isPromotionPassing(undefined)).toBe(false);
	});
});

describe("releasePrGate", () => {
	it("returns passed when ryzen sha equals dev sha", () => {
		const ryzen = cell({ commitSha: "deadbeef", updatedAt: "2026-04-24T10:00:00Z" });
		const dev = cell({ commitSha: "deadbeef", updatedAt: "2026-04-24T11:00:00Z" });
		const state = releasePrGate(ryzen, dev);
		expect(state.status).toBe("passed");
		expect(state.label).toMatch(/aligned/);
	});

	it("returns pending when shas differ", () => {
		const ryzen = cell({ commitSha: "deadbeef" });
		const dev = cell({ commitSha: "cafef00d" });
		const state = releasePrGate(ryzen, dev);
		expect(state.status).toBe("pending");
		expect(state.label).toBe("not aligned");
	});

	it("returns unknown when data is missing", () => {
		expect(releasePrGate(null, cell()).status).toBe("unknown");
		expect(releasePrGate(cell(), null).status).toBe("unknown");
		expect(releasePrGate(cell(), cell()).status).toBe("unknown");
	});
});

describe("argoGates", () => {
	it("returns passed when staging sha matches dev sha", () => {
		const dev = cell({ commitSha: "deadbeef" });
		const staging = cell({ commitSha: "deadbeef" });
		expect(argoGates(dev, staging).status).toBe("passed");
	});

	it("returns failed when staging promotion health is Failed", () => {
		const dev = cell({ commitSha: "deadbeef" });
		const staging = cell({ commitSha: "cafef00d", promotionHealth: "Failed" });
		const state = argoGates(dev, staging);
		expect(state.status).toBe("failed");
		expect(state.label).toContain("failed");
	});

	it("returns pending 'waiting on dev health' when dev is not yet Healthy+Synced", () => {
		const dev = cell({
			commitSha: "deadbeef",
			healthStatus: "Progressing",
			syncStatus: "OutOfSync",
		});
		const staging = cell({ commitSha: "cafef00d" });
		const state = argoGates(dev, staging);
		expect(state.status).toBe("pending");
		expect(state.label).toBe("waiting on dev health");
	});

	it("returns pending 'soaking Nm' while within the soak window", () => {
		const now = 1_700_000_000_000;
		const fiveMinAgo = new Date(now - 5 * 60_000).toISOString();
		const dev = cell({
			commitSha: "deadbeef",
			healthStatus: "Healthy",
			syncStatus: "Synced",
			driftStatus: "in_sync",
			updatedAt: fiveMinAgo,
		});
		const staging = cell({ commitSha: "cafef00d" });
		const state = argoGates(dev, staging, { now: () => now });
		expect(state.status).toBe("pending");
		expect(state.label).toMatch(/soaking 5m|soaking 6m/);
	});

	it("returns pending 'promotion starting' when the soak has elapsed", () => {
		const now = 1_700_000_000_000;
		const longAgo = new Date(now - STAGING_SOAK_MS - 60_000).toISOString();
		const dev = cell({
			commitSha: "deadbeef",
			healthStatus: "Healthy",
			syncStatus: "Synced",
			driftStatus: "in_sync",
			updatedAt: longAgo,
		});
		const staging = cell({ commitSha: "cafef00d" });
		const state = argoGates(dev, staging, { now: () => now });
		expect(state.status).toBe("pending");
		expect(state.label).toBe("promotion starting");
	});

	it("returns pending 'soak timer unknown' when dev has no updatedAt", () => {
		const dev = cell({
			commitSha: "deadbeef",
			healthStatus: "Healthy",
			syncStatus: "Synced",
			driftStatus: "in_sync",
			updatedAt: null,
		});
		const staging = cell({ commitSha: "cafef00d" });
		const state = argoGates(dev, staging);
		expect(state.status).toBe("pending");
		expect(state.label).toBe("soak timer unknown");
	});

	it("falls back to live.healthStatus when promotionHealth is null", () => {
		const dev = cell({
			commitSha: "deadbeef",
			healthStatus: "Healthy",
			syncStatus: "Synced",
			driftStatus: "in_sync",
			updatedAt: new Date().toISOString(),
			promotionHealth: null,
		});
		// staging healthStatus = Degraded; expect failed.
		const staging = cell({
			commitSha: "cafef00d",
			promotionHealth: null,
			healthStatus: "Degraded",
		});
		const state = argoGates(dev, staging);
		expect(state.status).toBe("failed");
	});

	it("returns unknown when either cell is missing", () => {
		expect(argoGates(null, cell()).status).toBe("unknown");
		expect(argoGates(cell(), null).status).toBe("unknown");
	});
});
