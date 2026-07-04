import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowDataMock = vi.hoisted(() => {
	return {
		canViewContaminationRiskMetadata: vi.fn(async () => false),
		getBenchmarkInstanceDetail: vi.fn(),
	};
});

const benchmarkEnvironmentValidationMock = vi.hoisted(() => {
	return {
		planInstanceEnvironment: vi.fn(() => ({
			environmentStatus: "building",
			environmentKey: "sympy-1.7",
			buildStrategy: "swebench-harness",
			version: "1.7",
		})),
	};
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: workflowDataMock,
		benchmarkEnvironmentValidation: benchmarkEnvironmentValidationMock,
	}),
}));

import { GET } from "./[suiteSlug]/[instanceId]/+server";

describe("benchmark instance detail API", () => {
	beforeEach(() => {
		workflowDataMock.canViewContaminationRiskMetadata.mockReset();
		workflowDataMock.canViewContaminationRiskMetadata.mockResolvedValue(false);
		workflowDataMock.getBenchmarkInstanceDetail.mockReset();
		benchmarkEnvironmentValidationMock.planInstanceEnvironment.mockClear();
	});

	it("loads instance details through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "[suiteSlug]/[instanceId]/+server.ts"),
			"utf8",
		);
		const contaminationSource = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../../lib/server/benchmarks/contamination.ts",
			),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("getBenchmarkInstanceDetail");
		expect(source).toContain("canViewContaminationRiskMetadata");
		expect(source).toContain("benchmarkEnvironmentValidation");
		expect(source).toContain("planInstanceEnvironment");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("environment-image-builds");
		expect(contaminationSource).not.toContain("$lib/server/db");
		expect(contaminationSource).not.toContain("$lib/server/db/schema");
		expect(contaminationSource).not.toContain("drizzle-orm");
	});

	it("redacts contamination-risk metadata by default", async () => {
		workflowDataMock.getBenchmarkInstanceDetail.mockResolvedValue(sampleInstanceRow());

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
		expect(workflowDataMock.canViewContaminationRiskMetadata).not.toHaveBeenCalled();
		expect(workflowDataMock.getBenchmarkInstanceDetail).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
		});
		expect(
			benchmarkEnvironmentValidationMock.planInstanceEnvironment,
		).toHaveBeenCalledWith({
			dataset: "SWE-bench_Lite",
			suiteSlug: "SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			testMetadata: expect.objectContaining({ version: "1.7" }),
		});
	});

	it("returns contamination-risk metadata only in explicit authorized audit mode", async () => {
		workflowDataMock.canViewContaminationRiskMetadata.mockResolvedValue(true);
		workflowDataMock.getBenchmarkInstanceDetail.mockResolvedValue(sampleInstanceRow());

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
		expect(workflowDataMock.canViewContaminationRiskMetadata).toHaveBeenCalledWith({
			userId: "user_1",
			projectId: "project_1",
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
