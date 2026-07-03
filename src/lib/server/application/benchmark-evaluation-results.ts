import type {
	BenchmarkEvaluationEventNotifier,
	BenchmarkEvaluationIngestResult,
	BenchmarkEvaluationResultInput,
	BenchmarkEvaluationResultRepository,
	BenchmarkEvaluationResultUpdate,
	BenchmarkEvaluationRunInstanceStatus,
	BenchmarkEvaluationRunStatus,
	BenchmarkEvaluationStatus,
	BenchmarkEvaluationTelemetryPort,
	BenchmarkRunLifecyclePort,
} from "$lib/server/application/ports";
import { compareToGold, parsePatchStats } from "$lib/server/benchmarks/patch-compare";

const TERMINAL_RUN_STATUSES = new Set<BenchmarkEvaluationRunStatus>([
	"completed",
	"failed",
	"cancelled",
]);

export class ApplicationBenchmarkEvaluationResultsService {
	constructor(
		private readonly deps: {
			results: BenchmarkEvaluationResultRepository;
			lifecycle: BenchmarkRunLifecyclePort;
			telemetry: BenchmarkEvaluationTelemetryPort;
			events: BenchmarkEvaluationEventNotifier;
		},
	) {}

	async ingest(input: {
		runId: string;
		results?: BenchmarkEvaluationResultInput[];
		error?: string | null;
		jobName?: string | null;
		receivedAt?: Date;
	}): Promise<BenchmarkEvaluationIngestResult> {
		const evaluatorError =
			typeof input.error === "string" && input.error.trim()
				? input.error.trim()
				: null;
		const results = Array.isArray(input.results) ? input.results : [];
		const run = await this.deps.results.getRunForEvaluationIngestion(input.runId);
		if (!run) return { status: "run_not_found" };

		if (TERMINAL_RUN_STATUSES.has(run.status)) {
			await this.notify(input.runId, {
				eventType: results.length > 0 ? "results" : "failed",
				jobName: input.jobName,
				error: evaluatorError ?? `ignored callback for terminal ${run.status} run`,
			});
			return { status: "skipped", run };
		}

		if (run.status === "inferencing") {
			const marked = await this.deps.lifecycle.markStatus(input.runId, "evaluating", {
				...(typeof input.jobName === "string" ? { evaluatorJobName: input.jobName } : {}),
			});
			if (marked && TERMINAL_RUN_STATUSES.has(marked.status)) {
				await this.notify(input.runId, {
					eventType: results.length > 0 ? "results" : "failed",
					jobName: input.jobName,
					error: evaluatorError ?? `ignored callback for terminal ${marked.status} run`,
				});
				return { status: "skipped", run: marked };
			}
		}

		if (evaluatorError && results.length === 0) {
			await this.deps.lifecycle.markStatus(input.runId, "failed", {
				error: evaluatorError,
			});
			await this.notify(input.runId, {
				eventType: "failed",
				jobName: input.jobName,
				error: evaluatorError,
			});
			return { status: "ok" };
		}

		const patchContexts = await this.deps.results.loadPatchContexts(input.runId);
		const updates = buildEvaluationResultUpdates(results, patchContexts);
		const updatedInstanceIds = updates.map((update) => update.instanceId);
		if (updates.length > 0) {
			await this.deps.results.batchUpdateEvaluationResults({
				runId: input.runId,
				updates,
				evaluatedAt: input.receivedAt ?? new Date(),
			});
		}

		try {
			this.deps.telemetry.syncEvaluationResults({
				runId: input.runId,
				instanceIds: updatedInstanceIds,
			});
		} catch (err) {
			console.warn(
				`SWE-bench evaluation telemetry sync scheduling failed for ${input.runId}:`,
				err,
			);
		}

		const summary = await this.deps.lifecycle.recomputeSummary(input.runId);
		const activeCount = await this.deps.results.countActiveEvaluationRows(input.runId);
		if (activeCount === 0) {
			const failed =
				Number(summary.failed ?? 0) +
				Number(summary.error ?? 0) +
				Number(summary.timeout ?? 0);
			await this.deps.lifecycle.markStatus(
				input.runId,
				"completed",
				{
					summary,
					error:
						failed > 0
							? `${failed} benchmark instances did not resolve`
							: evaluatorError,
				},
				{ terminalCleanup: "background" },
			);
		}

		const latestRun = await this.deps.results.getRunForResponse(input.runId);
		await this.notify(input.runId, {
			eventType: results.length > 0 ? "results" : "failed",
			jobName: input.jobName,
			error: evaluatorError,
		});
		return {
			status: "ok",
			run: latestRun,
			summary,
			updatedInstanceIds,
		};
	}

	private notify(
		runId: string,
		event: { eventType: "results" | "failed"; jobName?: string | null; error?: string | null },
	) {
		return this.deps.events.notifyEvaluationEvent({
			runId,
			eventType: event.eventType,
			jobName: event.jobName,
			error: event.error,
		});
	}
}

export function buildEvaluationResultUpdates(
	results: BenchmarkEvaluationResultInput[],
	patchContexts: Map<string, { modelPatch: string | null; goldPatch: string | null }>,
): BenchmarkEvaluationResultUpdate[] {
	return results
		.map((result) => {
			const instanceId = result.instance_id ?? result.instanceId;
			if (!instanceId) return null;
			const { status, evaluationStatus } = mapBenchmarkHarnessStatus(result);
			const ctx = patchContexts.get(instanceId);
			const stats = ctx ? parsePatchStats(ctx.modelPatch) : null;
			const overlap = ctx ? compareToGold(ctx.modelPatch, ctx.goldPatch) : null;
			return {
				instanceId,
				status,
				evaluationStatus,
				error: result.error ?? null,
				evaluationError: result.error ?? null,
				logsPath: result.logs_path ?? result.logsPath ?? null,
				testOutputSummary:
					result.test_output_summary ?? result.testOutputSummary ?? null,
				harnessResult: result.harness_result ?? result.harnessResult ?? null,
				patchAddedLines: stats?.addedLines ?? null,
				patchRemovedLines: stats?.removedLines ?? null,
				patchFilesTouched: stats?.filesTouched.length ?? null,
				patchFilesOverlapGold: overlap?.filesOverlap ?? null,
				patchWellFormed: stats?.wellFormed ?? null,
			};
		})
		.filter((update): update is BenchmarkEvaluationResultUpdate => update !== null);
}

export function mapBenchmarkHarnessStatus(result: BenchmarkEvaluationResultInput): {
	status: BenchmarkEvaluationRunInstanceStatus;
	evaluationStatus: BenchmarkEvaluationStatus;
} {
	if (result.status === "timeout") {
		return { status: "timeout", evaluationStatus: "timeout" };
	}
	if (result.status === "error") {
		return { status: "error", evaluationStatus: "error" };
	}
	if (result.status === "empty_patch") {
		return { status: "failed", evaluationStatus: "empty_patch" };
	}
	if (result.resolved === true || result.status === "resolved") {
		return { status: "resolved", evaluationStatus: "resolved" };
	}
	if (
		result.resolved === false ||
		result.status === "failed" ||
		result.status === "unresolved"
	) {
		return { status: "failed", evaluationStatus: "unresolved" };
	}
	return { status: "error", evaluationStatus: "error" };
}
