import type { BenchmarkRunInstanceDetailMlflowLinks } from "$lib/server/application/benchmark-run-instance-detail";

export class EnvBenchmarkRunInstanceMlflowLinks
	implements BenchmarkRunInstanceDetailMlflowLinks
{
	runUrl(input: {
		experimentId: string | null | undefined;
		runId: string | null | undefined;
	}): string | null {
		void input;
		return null;
	}

	tracesUrl(input: {
		experimentId: string | null | undefined;
		traceId: string | null | undefined;
	}): string | null {
		void input.experimentId;
		const traceId = input.traceId?.trim();
		if (!traceId) return null;
		return `/observability/${encodeURIComponent(traceId.replace(/^tr-/, ""))}`;
	}
}
