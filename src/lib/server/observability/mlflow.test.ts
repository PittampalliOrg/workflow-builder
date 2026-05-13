import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.doUnmock("$env/dynamic/public");
	vi.doUnmock("$env/dynamic/private");
	vi.resetModules();
});

describe("publicMlflowTraceSearchUrl", () => {
	it("links traces by MLflow request id in the trace experiment", async () => {
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example/" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		const { publicMlflowTraceSearchUrl } = await import("./mlflow");

		expect(publicMlflowTraceSearchUrl("3", { traceId: "abc123" })).toBe(
			"https://mlflow.example/#/experiments/3/traces?selectedEvaluationId=tr-abc123",
		);
	});

	it("does not double-prefix existing MLflow trace request ids", async () => {
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example" },
		}));
		vi.doMock("$env/dynamic/private", () => ({ env: {} }));
		const { publicMlflowTraceSearchUrl } = await import("./mlflow");

		expect(publicMlflowTraceSearchUrl("3", { traceId: "tr-abc123" })).toBe(
			"https://mlflow.example/#/experiments/3/traces?selectedEvaluationId=tr-abc123",
		);
	});

	it("resolves execution trace links from the execution MLflow experiment before the legacy trace env", async () => {
		const chain = {
			from: vi.fn().mockReturnThis(),
			where: vi.fn().mockReturnThis(),
			limit: vi.fn().mockResolvedValue([
				{
					primaryTraceId: "abc123",
					mlflowExperimentId: "workflow-exp-11",
				},
			]),
		};
		vi.doMock("$env/dynamic/public", () => ({
			env: { PUBLIC_MLFLOW_URL: "https://mlflow.example" },
		}));
		vi.doMock("$env/dynamic/private", () => ({
			env: { MLFLOW_TRACE_EXPERIMENT_ID: "legacy-traces" },
		}));
		vi.doMock("$lib/server/db", () => ({ db: { select: () => chain } }));
		vi.doMock("$lib/server/db/schema", () => ({
			workflowExecutions: {
				id: "id",
				primaryTraceId: "primary_trace_id",
				mlflowExperimentId: "mlflow_experiment_id",
			},
		}));
		vi.doMock("drizzle-orm", () => ({ eq: vi.fn() }));
		const { resolveMlflowTraceUrlForExecution } = await import("./mlflow");

		await expect(resolveMlflowTraceUrlForExecution("exec_1")).resolves.toBe(
			"https://mlflow.example/#/experiments/workflow-exp-11/traces?selectedEvaluationId=tr-abc123",
		);
	});
});
