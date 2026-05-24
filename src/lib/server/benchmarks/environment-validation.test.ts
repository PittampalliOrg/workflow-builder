import { describe, expect, it } from "vitest";
import {
	buildExactReadySelection,
	type SwebenchEnvironmentPlan,
} from "./environment-validation";

function plan(
	statuses: Array<["validated" | "building" | "not_built" | "failed", string]>,
	requestedInstanceIds: string[] = [],
): SwebenchEnvironmentPlan {
	const planned = statuses.map(([status, instanceId]) => ({
		status,
		envSpecHash: `${instanceId}-hash`,
		environmentKey: `${instanceId}-env`,
		row: {
			instanceId,
			repo: "sympy/sympy",
			baseCommit: "abc123",
			testMetadata: {},
		} as any,
	}));
	return {
		suite: {
			id: "suite-1",
			slug: "SWE-bench_Verified",
			datasetName: "princeton-nlp/SWE-bench_Verified",
		},
		suiteSlug: "SWE-bench_Verified",
		requestedInstanceIds,
		missingInstanceIds: [],
		planned,
		coverage: {
			total: planned.length,
			validated: planned.filter((item) => item.status === "validated").length,
			building: planned.filter((item) => item.status === "building").length,
			failed: planned.filter((item) => item.status === "failed").length,
			notBuilt: planned.filter((item) => item.status === "not_built").length,
			missingMetadata: 0,
		},
		nextExactReadyInstanceIds: planned
			.filter((item) => item.status === "validated")
			.map((item) => item.row.instanceId),
	};
}

describe("SWE-bench environment validation selection", () => {
	it("reports selected_instance_count when requested limit exceeds exact-ready coverage", () => {
		const selection = buildExactReadySelection({
			plan: plan([
				["validated", "one"],
				["building", "two"],
				["not_built", "three"],
			]),
			requestedLimit: 2,
		});

		expect(selection.selectedInstanceIds).toEqual(["one"]);
		expect(selection.requestedLimit).toBe(2);
		expect(selection.selectedCount).toBe(1);
		expect(selection.missingValidatedCount).toBe(1);
		expect(selection.primaryLimiter).toBe("selected_instance_count");
		expect(selection.coverage).toMatchObject({
			validated: 1,
			building: 1,
			notBuilt: 1,
		});
	});

	it("requires explicit instance IDs to be exact-ready", () => {
		const selection = buildExactReadySelection({
			plan: plan(
				[
					["validated", "ready"],
					["building", "queued"],
					["failed", "failed"],
				],
				["ready", "queued", "failed"],
			),
			requestedLimit: 3,
			requestedInstanceIds: ["ready", "queued", "failed"],
		});

		expect(selection.selectedInstanceIds).toEqual(["ready"]);
		expect(selection.missingExactInstanceIds).toEqual(["queued", "failed"]);
		expect(selection.missingValidatedCount).toBe(2);
		expect(selection.primaryLimiter).toBe("selected_instance_count");
	});
});
