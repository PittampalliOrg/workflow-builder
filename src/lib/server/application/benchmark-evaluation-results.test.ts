import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationBenchmarkEvaluationResultsService,
	buildEvaluationResultUpdates,
	mapBenchmarkHarnessStatus,
} from "$lib/server/application/benchmark-evaluation-results";
import type {
	BenchmarkEvaluationEventNotifier,
	BenchmarkEvaluationResultRepository,
	BenchmarkEvaluationTelemetryPort,
	BenchmarkRunLifecyclePort,
} from "$lib/server/application/ports";

function resultRepository(): BenchmarkEvaluationResultRepository {
	return {
		getRunForEvaluationIngestion: vi.fn(async () => ({
			id: "run-1",
			status: "inferencing" as const,
		})),
		loadPatchContexts: vi.fn(async () =>
			new Map([
				[
					"inst-1",
					{
						modelPatch:
							"diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new\n",
						goldPatch:
							"diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+expected\n",
					},
				],
			]),
		),
		batchUpdateEvaluationResults: vi.fn(async () => undefined),
		countActiveEvaluationRows: vi.fn(async () => 0),
		getRunForResponse: vi.fn(async () => ({
			id: "run-1",
			status: "completed" as const,
		})),
	};
}

function lifecycle(): BenchmarkRunLifecyclePort {
	return {
		markStatus: vi.fn(async (_runId, status) => ({ id: "run-1", status })),
		recomputeSummary: vi.fn(async () => ({
			resolved: 1,
			failed: 0,
			error: 0,
			timeout: 0,
		})),
	};
}

function telemetry(): BenchmarkEvaluationTelemetryPort {
	return {
		syncEvaluationResults: vi.fn(),
	};
}

function notifier(): BenchmarkEvaluationEventNotifier {
	return {
		notifyEvaluationEvent: vi.fn(async () => undefined),
	};
}

describe("benchmark evaluation result ingestion", () => {
	let results: BenchmarkEvaluationResultRepository;
	let runLifecycle: BenchmarkRunLifecyclePort;
	let evaluationTelemetry: BenchmarkEvaluationTelemetryPort;
	let events: BenchmarkEvaluationEventNotifier;

	beforeEach(() => {
		results = resultRepository();
		runLifecycle = lifecycle();
		evaluationTelemetry = telemetry();
		events = notifier();
	});

	it("maps harness statuses without schema types", () => {
		expect(mapBenchmarkHarnessStatus({ status: "timeout" })).toEqual({
			status: "timeout",
			evaluationStatus: "timeout",
		});
		expect(mapBenchmarkHarnessStatus({ status: "empty_patch" })).toEqual({
			status: "failed",
			evaluationStatus: "empty_patch",
		});
		expect(mapBenchmarkHarnessStatus({ resolved: true })).toEqual({
			status: "resolved",
			evaluationStatus: "resolved",
		});
		expect(mapBenchmarkHarnessStatus({ resolved: false })).toEqual({
			status: "failed",
			evaluationStatus: "unresolved",
		});
	});

	it("builds batch updates and skips results without instance ids", () => {
		const updates = buildEvaluationResultUpdates(
			[
				{ instance_id: "inst-1", resolved: true, logs_path: "logs.txt" },
				{ resolved: false },
			],
			new Map([
				[
					"inst-1",
					{
						modelPatch:
							"diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+new\n",
						goldPatch:
							"diff --git a/foo.py b/foo.py\n--- a/foo.py\n+++ b/foo.py\n@@ -1 +1 @@\n-old\n+expected\n",
					},
				],
			]),
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({
			instanceId: "inst-1",
			status: "resolved",
			evaluationStatus: "resolved",
			logsPath: "logs.txt",
			patchAddedLines: 1,
			patchRemovedLines: 1,
			patchFilesTouched: 1,
			patchFilesOverlapGold: 1,
			patchWellFormed: true,
		});
	});

	it("skips callbacks for terminal runs but still notifies the coordinator", async () => {
		vi.mocked(results.getRunForEvaluationIngestion).mockResolvedValueOnce({
			id: "run-1",
			status: "completed",
		});
		const service = new ApplicationBenchmarkEvaluationResultsService({
			results,
			lifecycle: runLifecycle,
			telemetry: evaluationTelemetry,
			events,
		});

		const result = await service.ingest({
			runId: "run-1",
			results: [{ instance_id: "inst-1", resolved: true }],
			error: null,
			jobName: "job-1",
		});

		expect(result.status).toBe("skipped");
		expect(events.notifyEvaluationEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				eventType: "results",
				jobName: "job-1",
				error: "ignored callback for terminal completed run",
			}),
		);
		expect(results.batchUpdateEvaluationResults).not.toHaveBeenCalled();
	});

	it("marks evaluator-only failures without trying to batch update", async () => {
		const service = new ApplicationBenchmarkEvaluationResultsService({
			results,
			lifecycle: runLifecycle,
			telemetry: evaluationTelemetry,
			events,
		});

		const result = await service.ingest({
			runId: "run-1",
			results: [],
			error: "job failed",
			jobName: "job-1",
		});

		expect(result.status).toBe("ok");
		expect(runLifecycle.markStatus).toHaveBeenCalledWith("run-1", "evaluating", {
			evaluatorJobName: "job-1",
		});
		expect(runLifecycle.markStatus).toHaveBeenCalledWith("run-1", "failed", {
			error: "job failed",
		});
		expect(results.batchUpdateEvaluationResults).not.toHaveBeenCalled();
		expect(events.notifyEvaluationEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				eventType: "failed",
				error: "job failed",
			}),
		);
	});

	it("batch-updates results, schedules telemetry, recomputes summary, and completes inactive runs", async () => {
		const service = new ApplicationBenchmarkEvaluationResultsService({
			results,
			lifecycle: runLifecycle,
			telemetry: evaluationTelemetry,
			events,
		});

		const result = await service.ingest({
			runId: "run-1",
			results: [{ instance_id: "inst-1", resolved: true }],
			receivedAt: new Date("2026-07-03T12:00:00.000Z"),
		});

		expect(result).toMatchObject({
			status: "ok",
			run: { id: "run-1", status: "completed" },
			summary: { resolved: 1 },
			updatedInstanceIds: ["inst-1"],
		});
		expect(results.batchUpdateEvaluationResults).toHaveBeenCalledWith({
			runId: "run-1",
			evaluatedAt: new Date("2026-07-03T12:00:00.000Z"),
			updates: [
				expect.objectContaining({
					instanceId: "inst-1",
					status: "resolved",
					evaluationStatus: "resolved",
				}),
			],
		});
		expect(evaluationTelemetry.syncEvaluationResults).toHaveBeenCalledWith({
			runId: "run-1",
			instanceIds: ["inst-1"],
		});
		expect(runLifecycle.markStatus).toHaveBeenCalledWith(
			"run-1",
			"completed",
			{
				summary: { resolved: 1, failed: 0, error: 0, timeout: 0 },
				error: null,
			},
			{ terminalCleanup: "background" },
		);
	});
});
