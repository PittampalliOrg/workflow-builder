import { env as privateEnv } from "$env/dynamic/private";
import { env as publicEnv } from "$env/dynamic/public";
import type { BenchmarkRunInstanceDetailMlflowLinks } from "$lib/server/application/benchmark-run-instance-detail";

export class EnvBenchmarkRunInstanceMlflowLinks
	implements BenchmarkRunInstanceDetailMlflowLinks
{
	runUrl(input: {
		experimentId: string | null | undefined;
		runId: string | null | undefined;
	}): string | null {
		const base = (
			publicEnv.PUBLIC_MLFLOW_URL ??
			privateEnv.PUBLIC_MLFLOW_URL ??
			""
		)
			.trim()
			.replace(/\/+$/, "");
		if (!base || !input.experimentId || !input.runId) return null;
		return `${base}/#/experiments/${encodeURIComponent(
			input.experimentId,
		)}/runs/${encodeURIComponent(input.runId)}`;
	}

	tracesUrl(input: {
		experimentId: string | null | undefined;
		traceId: string | null | undefined;
	}): string | null {
		void input.experimentId;
		const traceId = input.traceId?.trim();
		if (!traceId) return null;
		return `/api/observability/mlflow/traces/${encodeURIComponent(traceId)}`;
	}
}
