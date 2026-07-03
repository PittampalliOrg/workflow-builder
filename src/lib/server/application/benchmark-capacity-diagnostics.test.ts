import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkCapacityDiagnosticsService,
	type BenchmarkCapacityDiagnosticsPort,
} from "$lib/server/application/benchmark-capacity-diagnostics";

describe("ApplicationBenchmarkCapacityDiagnosticsService", () => {
	let capacity: BenchmarkCapacityDiagnosticsPort;
	let service: ApplicationBenchmarkCapacityDiagnosticsService;

	beforeEach(() => {
		capacity = {
			inspectLaunchCapacity: vi.fn(async () => ({
				status: "ok" as const,
				diagnostics: { computedAt: "now" } as never,
			})),
			getRunCapacity: vi.fn(async () => ({ computedAt: "then" }) as never),
		};
		service = new ApplicationBenchmarkCapacityDiagnosticsService(capacity);
	});

	it("rejects launch inspection without a project scope", async () => {
		await expect(
			service.inspectLaunchCapacity({ projectId: null, body: {} }),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			message: "No active workspace — cannot inspect benchmark capacity",
		});
		expect(capacity.inspectLaunchCapacity).not.toHaveBeenCalled();
	});

	it("normalizes launch inspection body before calling the port", async () => {
		await expect(
			service.inspectLaunchCapacity({
				projectId: "project-1",
				body: {
					agentId: "agent-1",
					agentVersion: "4",
					instanceIds: ["a", "b"],
					requestedConcurrency: "12",
					evaluationConcurrency: "3",
					modelNameOrPath: "openai/gpt-5.5",
					modelConfigLabel: "gpt",
					executionBackend: "kueue",
				},
			}),
		).resolves.toEqual({
			status: "ok",
			body: { diagnostics: { computedAt: "now" } },
		});

		expect(capacity.inspectLaunchCapacity).toHaveBeenCalledWith({
			projectId: "project-1",
			agentId: "agent-1",
			agentVersion: 4,
			instanceIds: ["a", "b"],
			instanceCount: undefined,
			requestedConcurrency: 12,
			evaluationConcurrency: 3,
			modelNameOrPath: "openai/gpt-5.5",
			modelConfigLabel: "gpt",
			executionBackend: "kueue",
		});
	});

	it("maps launch validation failures to route-ready 400 responses", async () => {
		vi.mocked(capacity.inspectLaunchCapacity).mockResolvedValueOnce({
			status: "validation_error",
			message: "invalid agent",
		});

		await expect(
			service.inspectLaunchCapacity({
				projectId: "project-1",
				body: { agentId: "bad" },
			}),
		).resolves.toEqual({
			status: "error",
			httpStatus: 400,
			body: { message: "invalid agent" },
		});
	});

	it("returns run capacity diagnostics through the port", async () => {
		await expect(
			service.getRunCapacity({ projectId: "project-1", runId: "run-1" }),
		).resolves.toEqual({
			status: "ok",
			body: { diagnostics: { computedAt: "then" } },
		});
		expect(capacity.getRunCapacity).toHaveBeenCalledWith("project-1", "run-1");
	});

	it("maps missing run capacity diagnostics to not found", async () => {
		vi.mocked(capacity.getRunCapacity).mockResolvedValueOnce(null);

		await expect(
			service.getRunCapacity({ projectId: "project-1", runId: "missing" }),
		).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Benchmark run not found",
		});
	});
});
