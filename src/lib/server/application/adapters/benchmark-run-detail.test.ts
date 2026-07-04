import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	LegacyBenchmarkRunDetailReadAdapter,
	type BenchmarkRunFailureContextRepository,
	type BuildBenchmarkRunFailureContext,
} from "$lib/server/application/adapters/benchmark-run-detail";
import type { RunFailureContextSource } from "$lib/server/benchmarks/failure-context";

describe("LegacyBenchmarkRunDetailReadAdapter failure context", () => {
	it("loads failure context through the project-scoped repository", async () => {
		const run = failureContextRun();
		const failureContextRuns: BenchmarkRunFailureContextRepository = {
			getFailureContextRun: vi.fn(async () => run),
		};
		const buildFailureContext: BuildBenchmarkRunFailureContext = vi.fn(
			async () => ({
				windowFrom: "2026-07-01T09:59:00.000Z",
				windowTo: "2026-07-01T10:10:30.000Z",
				cluster: "dev",
				kueue: {
					pendingWorkloadsAtEnd: null,
					preemptionsInWindow: 0,
					admissionWaitP95Ms: null,
				},
				agentSandbox: {
					reconcileErrorsInWindow: 0,
				},
				dapr: {
					workflowFailedInWindow: 0,
					workflowRecoverableInWindow: 0,
					schedulingLatencyP95Ms: null,
				},
			}),
		);
		const adapter = new LegacyBenchmarkRunDetailReadAdapter({
			failureContextRuns,
			buildFailureContext,
		});

		await expect(
			adapter.getFailureContext("project-1", "run-1"),
		).resolves.toMatchObject({
			windowFrom: "2026-07-01T09:59:00.000Z",
			cluster: "dev",
		});
		expect(failureContextRuns.getFailureContextRun).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
		expect(buildFailureContext).toHaveBeenCalledWith(run);
	});

	it("does not build failure context when the repository misses", async () => {
		const failureContextRuns: BenchmarkRunFailureContextRepository = {
			getFailureContextRun: vi.fn(async () => null),
		};
		const buildFailureContext: BuildBenchmarkRunFailureContext = vi.fn(
			async () => null,
		);
		const adapter = new LegacyBenchmarkRunDetailReadAdapter({
			failureContextRuns,
			buildFailureContext,
		});

		await expect(
			adapter.getFailureContext("project-1", "missing"),
		).resolves.toBeNull();
		expect(buildFailureContext).not.toHaveBeenCalled();
	});

	it("keeps direct database access out of the failure-context metric builder", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../benchmarks/failure-context.ts",
			),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("benchmarkRuns");
	});
});

function failureContextRun(): RunFailureContextSource {
	return {
		status: "failed",
		startedAt: new Date("2026-07-01T10:00:00.000Z"),
		completedAt: new Date("2026-07-01T10:10:00.000Z"),
		createdAt: new Date("2026-07-01T09:55:00.000Z"),
	};
}
