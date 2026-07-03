import { describe, expect, it, vi } from "vitest";
import { ApplicationBenchmarkInstanceLifecycleService } from "$lib/server/application/benchmark-instance-lifecycle";
import type { BenchmarkInstanceLifecyclePort } from "$lib/server/application/ports";

describe("ApplicationBenchmarkInstanceLifecycleService", () => {
	it("delegates benchmark instance starts to the lifecycle port", async () => {
		const lifecycle: BenchmarkInstanceLifecyclePort = {
			startBenchmarkInstanceWorkflow: vi.fn(async () => ({
				workflowExecutionId: "exec-1",
			})),
			terminateBenchmarkRunInstance: vi.fn(),
		};
		const service = new ApplicationBenchmarkInstanceLifecycleService(lifecycle);

		await expect(
			service.startBenchmarkInstanceWorkflow({
				runId: "run-1",
				instanceId: "astropy__astropy-7166",
			}),
		).resolves.toEqual({ workflowExecutionId: "exec-1" });
		expect(lifecycle.startBenchmarkInstanceWorkflow).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "astropy__astropy-7166",
		});
	});

	it("delegates benchmark instance termination to the lifecycle port", async () => {
		const lifecycle: BenchmarkInstanceLifecyclePort = {
			startBenchmarkInstanceWorkflow: vi.fn(),
			terminateBenchmarkRunInstance: vi.fn(async () => ({
				cleanupConfirmed: false,
				status: "terminating",
			})),
		};
		const service = new ApplicationBenchmarkInstanceLifecycleService(lifecycle);

		await expect(
			service.terminateBenchmarkRunInstance({
				projectId: "project-1",
				runId: "run-1",
				instanceId: "astropy__astropy-7166",
				reason: "user requested stop",
			}),
		).resolves.toEqual({ cleanupConfirmed: false, status: "terminating" });
		expect(lifecycle.terminateBenchmarkRunInstance).toHaveBeenCalledWith({
			projectId: "project-1",
			runId: "run-1",
			instanceId: "astropy__astropy-7166",
			reason: "user requested stop",
		});
	});
});
