import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflowData: {
		ingestBenchmarkEvaluationResults: vi.fn(),
	},
	requireInternal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requireInternal: mocks.requireInternal,
}));

import { POST } from "./[runId]/evaluation-results/+server";

describe("internal benchmark evaluation-results route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.ingestBenchmarkEvaluationResults.mockResolvedValue({
			status: "ok",
			run: { id: "run-1", status: "completed" },
			summary: { resolved: 1 },
		});
	});

	it("keeps the callback route free of direct DB imports", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"[runId]/evaluation-results/+server.ts",
			),
			"utf8",
		);
		expect(source).toContain("ingestBenchmarkEvaluationResults");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates normalized callback bodies to workflow-data", async () => {
		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					results: [{ instance_id: "inst-1", resolved: true }],
					error: "",
					jobName: "job-1",
				}),
			}),
			params: { runId: "run-1" },
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			run: { id: "run-1", status: "completed" },
			summary: { resolved: 1 },
		});
		expect(mocks.requireInternal).toHaveBeenCalled();
		expect(mocks.workflowData.ingestBenchmarkEvaluationResults).toHaveBeenCalledWith({
			runId: "run-1",
			results: [{ instance_id: "inst-1", resolved: true }],
			error: "",
			jobName: "job-1",
		});
	});

	it("preserves skipped callback response shape", async () => {
		mocks.workflowData.ingestBenchmarkEvaluationResults.mockResolvedValueOnce({
			status: "skipped",
			run: { id: "run-1", status: "completed" },
		});

		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({ results: [] }),
			}),
			params: { runId: "run-1" },
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			skipped: true,
			run: { id: "run-1", status: "completed" },
		});
	});

	it("maps missing run to 404", async () => {
		mocks.workflowData.ingestBenchmarkEvaluationResults.mockResolvedValueOnce({
			status: "run_not_found",
		});

		await expect(
			POST({
				request: new Request("http://localhost", { method: "POST", body: "{}" }),
				params: { runId: "missing" },
			} as never),
		).rejects.toMatchObject({ status: 404 });
	});
});
