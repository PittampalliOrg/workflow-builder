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
});
