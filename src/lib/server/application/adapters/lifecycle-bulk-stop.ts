import { env } from "$env/dynamic/private";
import type {
	BenchmarkRunCancellationPort,
	EvaluationRunCancellationPort,
	LifecycleCoordinatorCancelNotifier,
} from "$lib/server/application/ports";
import {
	cancelBenchmarkRun,
	getSwebenchCoordinatorUrl,
} from "$lib/server/benchmarks/service";
import {
	cancelEvaluationRun,
	getEvaluationCoordinatorUrl,
} from "$lib/server/evaluations/service";
import { daprFetch } from "$lib/server/dapr-client";

export class ServiceBenchmarkRunCancellationPort
	implements BenchmarkRunCancellationPort
{
	cancelBenchmarkRun(
		projectId: string,
		runId: string,
		options?: { terminalCleanup?: "background" | "sync" },
	) {
		return cancelBenchmarkRun(projectId, runId, options);
	}
}

export class ServiceEvaluationRunCancellationPort
	implements EvaluationRunCancellationPort
{
	cancelEvaluationRun(projectId: string, runId: string) {
		return cancelEvaluationRun(projectId, runId);
	}
}

export class DaprLifecycleCoordinatorCancelNotifier
	implements LifecycleCoordinatorCancelNotifier
{
	scheduleCoordinatorCancel(kind: "benchmarkRun" | "evalRun", runId: string): void {
		const token = env.INTERNAL_API_TOKEN;
		if (!token) return;
		void (async () => {
			try {
				const url =
					kind === "benchmarkRun"
						? `${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs/${runId}/cancel`
						: `${getEvaluationCoordinatorUrl()}/api/v1/evaluation-runs/${runId}/cancel`;
				const res = await daprFetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Internal-Token": token,
					},
					body: JSON.stringify({ reason: "cancelled by user (bulk)" }),
					maxRetries: 0,
					signal: AbortSignal.timeout(120_000),
				});
				if (!res.ok) {
					console.warn(
						`[bulk-stop] coordinator cancel failed for ${kind} ${runId}: ${res.status} ${await res.text()}`,
					);
				}
			} catch (err) {
				console.warn(
					`[bulk-stop] coordinator cancel failed for ${kind} ${runId}:`,
					err instanceof Error ? err.message : err,
				);
			}
		})();
	}
}
