import { afterEach, describe, expect, it, vi } from "vitest";
import {
	benchmarkExecutionBackend,
	benchmarkExecutionClass,
	hostExecutionPlaneUrl,
	isHostExecutionIr,
	submitBenchmarkInstanceToHostExecutionPlane,
} from "./execution-plane";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("benchmark host execution plane config", () => {
	it("defaults to the legacy Dapr backend and benchmark-fast class", () => {
		expect(benchmarkExecutionBackend()).toBe("legacy-dapr");
		expect(benchmarkExecutionClass()).toBe("benchmark-fast");
	});

	it("normalizes host backend, secure-gvisor class, and URL", () => {
		vi.stubEnv("BENCHMARK_EXECUTION_BACKEND", "host_execution_plane");
		vi.stubEnv("BENCHMARK_EXECUTION_CLASS", "secure_gvisor");
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-exec:8080/");

		expect(benchmarkExecutionBackend()).toBe("host");
		expect(benchmarkExecutionClass()).toBe("secure-gvisor");
		expect(hostExecutionPlaneUrl()).toBe("http://sandbox-exec:8080");
	});

	it("detects host-dispatched execution IR snapshots", () => {
		expect(isHostExecutionIr({ dispatch: { backend: "host" } })).toBe(true);
		expect(isHostExecutionIr({ dispatch: { backend: "legacy-dapr" } })).toBe(
			false,
		);
		expect(isHostExecutionIr(null)).toBe(false);
	});
});

describe("submitBenchmarkInstanceToHostExecutionPlane", () => {
	it("posts the stable SWE-bench execution contract", async () => {
		vi.stubEnv("SANDBOX_EXECUTION_API_URL", "http://sandbox-exec:8080");
		vi.stubEnv("SANDBOX_EXECUTION_API_TOKEN", "secret-token");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						executionId: "hexec_1",
						jobName: "swebench-run-1",
						status: "queued",
					}),
					{ status: 202, headers: { "content-type": "application/json" } },
				),
			);

		const result = await submitBenchmarkInstanceToHostExecutionPlane({
			runId: "run_1",
			instanceId: "sympy__sympy-20590",
			workflowId: "wf_1",
			workflowExecutionId: "exec_1",
			executionClass: "benchmark-fast",
			timeoutSeconds: 7200,
			workflow: { document: { dsl: "1.0.0" } },
			triggerData: { runId: "run_1" },
			inferenceEnvironment: { sandboxImage: "ghcr.io/example/image@sha256:1" },
		});

		expect(result).toMatchObject({
			hostExecutionId: "hexec_1",
			jobName: "swebench-run-1",
			status: "queued",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://sandbox-exec:8080/api/v1/executions",
			expect.objectContaining({
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer secret-token",
				},
			}),
		);
		const body = JSON.parse(
			(fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
		);
		expect(body).toMatchObject({
			kind: "swebench-instance",
			runId: "run_1",
			instanceId: "sympy__sympy-20590",
			workflowExecutionId: "exec_1",
			executionClass: "benchmark-fast",
			callback: {
				path: "/api/internal/benchmarks/runs/run_1/instances/sympy__sympy-20590/execution",
			},
		});
	});
});
