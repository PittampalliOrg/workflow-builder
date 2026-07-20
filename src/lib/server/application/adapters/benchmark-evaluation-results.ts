import { env } from "$env/dynamic/private";
import {
	getSwebenchCoordinatorUrl,
	markBenchmarkRunStatus,
	recomputeRunSummary,
} from "$lib/server/application/adapters/benchmark-service";
import { daprFetch } from "$lib/server/dapr-client";
import type {
	BenchmarkEvaluationEventNotifier,
	BenchmarkEvaluationRunRecord,
	BenchmarkEvaluationRunStatus,
	BenchmarkEvaluationTelemetryPort,
	BenchmarkRunLifecyclePort,
} from "$lib/server/application/ports";

export class LegacyBenchmarkRunLifecycleAdapter implements BenchmarkRunLifecyclePort {
	async markStatus(
		runId: string,
		status: BenchmarkEvaluationRunStatus,
		extra: Record<string, unknown> = {},
		options: { terminalCleanup?: "background" | "sync" } = {},
	): Promise<BenchmarkEvaluationRunRecord | null> {
		return (await markBenchmarkRunStatus(runId, status, extra, options)) as
			| BenchmarkEvaluationRunRecord
			| null;
	}

	async recomputeSummary(runId: string): Promise<Record<string, unknown>> {
		return (await recomputeRunSummary(runId)) as Record<string, unknown>;
	}
}

export class NativeBenchmarkEvaluationTelemetryAdapter
	implements BenchmarkEvaluationTelemetryPort
{
	syncEvaluationResults(_input: { runId: string; instanceIds: string[] }): void {
		// The repository batch update and summary recomputation are authoritative.
		// Request and workflow instrumentation cover this boundary, so no second
		// evaluation tracking projection is required here.
	}
}

export class DaprBenchmarkEvaluationEventNotifier
	implements BenchmarkEvaluationEventNotifier
{
	async notifyEvaluationEvent(input: {
		runId: string;
		eventType: "results" | "failed";
		jobName?: string | null;
		error?: string | null;
		postedAt?: Date;
	}): Promise<void> {
		if (!env.INTERNAL_API_TOKEN) return;
		try {
			const res = await daprFetch(
				`${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${input.runId}/evaluation-events`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Internal-Token": env.INTERNAL_API_TOKEN,
					},
					body: JSON.stringify({
						eventType: input.eventType,
						jobName: input.jobName,
						error: input.error,
						postedAt: (input.postedAt ?? new Date()).toISOString(),
					}),
					maxRetries: 0,
				},
			);
			if (!res.ok) {
				console.warn(
					`SWE-bench coordinator evaluation event notification failed for ${input.runId}: ${res.status} ${await res.text()}`,
				);
			}
		} catch (err) {
			console.warn(
				`SWE-bench coordinator evaluation event notification failed for ${input.runId}:`,
				err,
			);
		}
	}
}
