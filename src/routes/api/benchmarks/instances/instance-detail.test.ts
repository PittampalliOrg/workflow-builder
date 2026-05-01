import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => {
	const queuedRows: Array<unknown[]> = [];
	const select = vi.fn(() => {
		const result = queuedRows.shift() ?? [];
		const chain: Record<string, unknown> = {};
		chain.from = vi.fn(() => chain);
		chain.innerJoin = vi.fn(() => chain);
		chain.where = vi.fn(() => chain);
		chain.limit = vi.fn(async () => result);
		return chain;
	});
	return {
		queuedRows,
		db: { select },
		select,
	};
});

vi.mock("$lib/server/db", () => ({
	db: dbMock.db,
}));

vi.mock("$lib/server/environments/environment-image-builds", () => ({
	plannedSwebenchInferenceEnvironment: vi.fn(() => ({
		environmentStatus: "building",
		environmentKey: "sympy-1.7",
		buildStrategy: "swebench-harness",
		version: "1.7",
	})),
}));

import { GET } from "./[suiteSlug]/[instanceId]/+server";

describe("benchmark instance detail API", () => {
	beforeEach(() => {
		dbMock.queuedRows.length = 0;
		dbMock.select.mockClear();
	});

	it("redacts contamination-risk metadata by default", async () => {
		dbMock.queuedRows.push([sampleInstanceRow()]);

		const response = (await GET({
			params: { suiteSlug: "SWE-bench_Lite", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user_1", projectId: "project_1" } },
			url: new URL(
				"http://localhost/api/benchmarks/instances/SWE-bench_Lite/sympy__sympy-20590",
			),
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.instance.testMetadata).toEqual({ version: "1.7" });
		expect(body.instance.goldPatch).toBeNull();
		expect(body.instance.metadata).toBeNull();
		expect(body.instance.contaminationRiskMetadata).toMatchObject({
			included: false,
			redacted: true,
		});
		expect(JSON.stringify(body)).not.toContain("test_patch");
		expect(JSON.stringify(body)).not.toContain("FAIL_TO_PASS");
		expect(JSON.stringify(body)).not.toContain("PASS_TO_PASS");
		expect(JSON.stringify(body)).not.toContain("sympy/core/add.py");
	});

	it("returns contamination-risk metadata only in explicit authorized audit mode", async () => {
		dbMock.queuedRows.push([{ platformRole: "ADMIN" }], [sampleInstanceRow()]);

		const response = (await GET({
			params: { suiteSlug: "SWE-bench_Lite", instanceId: "sympy__sympy-20590" },
			locals: { session: { userId: "user_1", projectId: "project_1" } },
			url: new URL(
				"http://localhost/api/benchmarks/instances/SWE-bench_Lite/sympy__sympy-20590?includeContaminationRiskMetadata=1",
			),
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.instance.testMetadata).toMatchObject({
			test_patch: "diff --git a/sympy/tests/test_add.py b/sympy/tests/test_add.py\n",
			FAIL_TO_PASS: ["sympy/tests/test_add.py::test_regression"],
			PASS_TO_PASS: ["sympy/tests/test_add.py::test_existing"],
		});
		expect(body.instance.goldPatch).toBe(
			"diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
		);
		expect(body.instance.contaminationRiskMetadata).toMatchObject({
			included: true,
			redacted: false,
		});
	});
});

function sampleInstanceRow() {
	return {
		id: "inst_1",
		instanceId: "sympy__sympy-20590",
		repo: "sympy/sympy",
		baseCommit: "abc123",
		problemStatement: "Fix it",
		hintsText: "Look at Add",
		testMetadata: {
			version: "1.7",
			test_patch: "diff --git a/sympy/tests/test_add.py b/sympy/tests/test_add.py\n",
			FAIL_TO_PASS: ["sympy/tests/test_add.py::test_regression"],
			PASS_TO_PASS: ["sympy/tests/test_add.py::test_existing"],
		},
		goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
		metadata: { issue_url: "https://example.test/issue" },
		suiteSlug: "SWE-bench_Lite",
		suiteName: "SWE-bench Lite",
	};
}
