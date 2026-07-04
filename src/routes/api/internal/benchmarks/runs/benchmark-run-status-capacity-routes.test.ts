import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInternal: vi.fn(),
	workflowData: {
		getBenchmarkRunProjectId: vi.fn(),
	},
	benchmarkCapacityDiagnostics: {
		getRunCapacity: vi.fn(),
	},
	getBenchmarkRun: vi.fn(),
	markBenchmarkRunStatus: vi.fn(),
	recomputeRunSummary: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		benchmarkCapacityDiagnostics: mocks.benchmarkCapacityDiagnostics,
	}),
}));

vi.mock("$lib/server/benchmarks/service", () => ({
	getBenchmarkRun: mocks.getBenchmarkRun,
	markBenchmarkRunStatus: mocks.markBenchmarkRunStatus,
	recomputeRunSummary: mocks.recomputeRunSummary,
}));

import { GET as getCapacityGate } from "./[runId]/capacity-gate/+server";
import { GET as getRunStatus } from "./[runId]/status/+server";

describe("internal benchmark run status and capacity routes", () => {
	beforeEach(() => {
		mocks.requireInternal.mockReset();
		mocks.workflowData.getBenchmarkRunProjectId.mockReset();
		mocks.getBenchmarkRun.mockReset();
		mocks.markBenchmarkRunStatus.mockReset();
		mocks.recomputeRunSummary.mockReset();
		mocks.benchmarkCapacityDiagnostics.getRunCapacity.mockReset();
	});

	it("loads run status through workflow-data project scope", async () => {
		mocks.workflowData.getBenchmarkRunProjectId.mockResolvedValue("project-1");
		mocks.getBenchmarkRun.mockResolvedValue({ id: "run-1", status: "running" });

		const response = (await getRunStatus({
			request: new Request("http://localhost"),
			params: { runId: "run-1" },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.requireInternal).toHaveBeenCalledTimes(1);
		expect(mocks.workflowData.getBenchmarkRunProjectId).toHaveBeenCalledWith("run-1");
		expect(mocks.getBenchmarkRun).toHaveBeenCalledWith("project-1", "run-1");
		expect(body).toEqual({ run: { id: "run-1", status: "running" } });
	});

	it("loads capacity diagnostics through workflow-data project scope", async () => {
		mocks.workflowData.getBenchmarkRunProjectId.mockResolvedValue("project-1");
		mocks.benchmarkCapacityDiagnostics.getRunCapacity.mockResolvedValue({
			status: "ok",
			body: {
				diagnostics: {
					pressureAdjustedConcurrency: 2,
					capReason: "",
					clusterPressure: null,
					parentWorkflow: { daprRuntimePressure: false },
					agentHostRuntime: { daprRuntimePressure: false },
					sandbox: {
						diskPressureNodeCount: 0,
						kueueClusterQueueActive: true,
					},
				},
			},
		});

		const response = (await getCapacityGate({
			request: new Request("http://localhost"),
			params: { runId: "run-1" },
		} as never)) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.workflowData.getBenchmarkRunProjectId).toHaveBeenCalledWith("run-1");
		expect(mocks.benchmarkCapacityDiagnostics.getRunCapacity).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
		});
		expect(body.success).toBe(true);
		expect(body.admitNewStarts).toBe(true);
	});

	it("keeps migrated routes free of direct DB imports", () => {
		for (const relativePath of [
			"[runId]/status/+server.ts",
			"[runId]/capacity-gate/+server.ts",
		]) {
			const source = readFileSync(
				join(dirname(fileURLToPath(import.meta.url)), relativePath),
				"utf8",
			);

			expect(source).toContain("getBenchmarkRunProjectId");
			if (relativePath.includes("capacity-gate")) {
				expect(source).toContain("benchmarkCapacityDiagnostics");
			}
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});

	it("keeps the lease route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "[runId]/leases/+server.ts"),
			"utf8",
		);

		expect(source).toContain("$lib/server/benchmarks/resource-leases");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});
