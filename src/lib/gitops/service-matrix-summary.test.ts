import { describe, expect, it } from "vitest";

import type {
	EnvCell,
	ServiceRow,
} from "./service-matrix";
import { summarizeRow } from "./service-matrix";

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

function row(envs: Partial<ServiceRow["envs"]>): ServiceRow {
	return {
		service: "workflow-builder",
		specialCase: null,
		envs: {
			ryzen: null,
			dev: null,
			staging: null,
			...envs,
		},
	};
}

describe("summarizeRow", () => {
	it("returns empty when no cells are populated", () => {
		const summary = summarizeRow(row({}));
		expect(summary.overall).toBe("empty");
		expect(summary.updatedAt).toBeNull();
	});

	it("returns healthy when all inventory cells are Synced+Healthy", () => {
		const s = summarizeRow(
			row({
				dev: cell({ syncStatus: "Synced", healthStatus: "Healthy", updatedAt: "2026-04-24T11:00:00Z" }),
				staging: cell({ syncStatus: "Synced", healthStatus: "Healthy" }),
			}),
		);
		expect(s.overall).toBe("healthy");
		expect(s.updatedAt).toBe("2026-04-24T11:00:00Z");
	});

	it("returns drift when any cell has pending rollout or OutOfSync", () => {
		const s = summarizeRow(
			row({
				dev: cell({ syncStatus: "Synced", healthStatus: "Healthy" }),
				staging: cell({ driftStatus: "pending_rollout" }),
			}),
		);
		expect(s.overall).toBe("drift");
	});

	it("returns degraded when any cell is Degraded (beats drift)", () => {
		const s = summarizeRow(
			row({
				dev: cell({ driftStatus: "pending_rollout" }),
				staging: cell({ healthStatus: "Degraded" }),
			}),
		);
		expect(s.overall).toBe("degraded");
	});

	it("returns degraded on a failed build", () => {
		const s = summarizeRow(
			row({
				dev: cell({ syncStatus: "Synced", healthStatus: "Healthy", buildStatus: "False", buildReason: "Failed" }),
			}),
		);
		expect(s.overall).toBe("degraded");
	});

	it("treats pin-only cells as healthy (not unknown)", () => {
		const s = summarizeRow(
			row({
				dev: cell({ source: "pin-only", tag: "git-abc" }),
				staging: cell({ source: "pin-only", tag: "git-abc" }),
			}),
		);
		expect(s.overall).toBe("healthy");
	});

	it("picks the newest updatedAt across populated cells", () => {
		const s = summarizeRow(
			row({
				dev: cell({ syncStatus: "Synced", healthStatus: "Healthy", updatedAt: "2026-04-24T10:00:00Z" }),
				staging: cell({
					syncStatus: "Synced",
					healthStatus: "Healthy",
					updatedAt: "2026-04-24T12:00:00Z",
				}),
			}),
		);
		expect(s.updatedAt).toBe("2026-04-24T12:00:00Z");
	});
});
