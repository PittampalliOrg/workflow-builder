import { env as privateEnv } from "$env/dynamic/private";
import { normalizeHeadlampCluster } from "$lib/headlamp/links";
import { getBenchmarkRun } from "$lib/server/benchmarks/service";
import { computeRunStats } from "$lib/server/benchmarks/stats";
import { getBenchmarkRunCapacityDiagnostics } from "$lib/server/benchmarks/capacity-diagnostics";
import { getBenchmarkRunPhaseAttribution } from "$lib/server/benchmarks/phase-attribution";
import { getRunFailureContext } from "$lib/server/benchmarks/failure-context";
import type { BenchmarkRunDetailReadPort } from "$lib/server/application/benchmark-run-detail";

export class LegacyBenchmarkRunDetailReadAdapter
	implements BenchmarkRunDetailReadPort
{
	getRun(projectId: string, runId: string) {
		return getBenchmarkRun(projectId, runId);
	}

	computeRunStats(runId: string) {
		return computeRunStats(runId);
	}

	getCapacityDiagnostics(projectId: string, runId: string) {
		return getBenchmarkRunCapacityDiagnostics(projectId, runId);
	}

	getPhaseAttribution(runId: string) {
		return getBenchmarkRunPhaseAttribution(runId);
	}

	getFailureContext(runId: string) {
		return getRunFailureContext(runId);
	}

	getHeadlampCluster() {
		return normalizeHeadlampCluster(privateEnv.WORKFLOW_BUILDER_ENV);
	}
}
