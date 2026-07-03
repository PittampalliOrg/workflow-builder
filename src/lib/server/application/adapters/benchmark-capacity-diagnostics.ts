import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import {
	getBenchmarkLaunchCapacityDiagnostics,
	getBenchmarkRunCapacityDiagnostics,
} from "$lib/server/benchmarks/capacity-diagnostics";
import type {
	BenchmarkCapacityDiagnosticsPort,
	BenchmarkLaunchCapacityInput,
} from "$lib/server/application/benchmark-capacity-diagnostics";

export class LegacyBenchmarkCapacityDiagnosticsAdapter
	implements BenchmarkCapacityDiagnosticsPort
{
	async inspectLaunchCapacity(input: BenchmarkLaunchCapacityInput) {
		try {
			return {
				status: "ok" as const,
				diagnostics: await getBenchmarkLaunchCapacityDiagnostics(input),
			};
		} catch (err) {
			if (err instanceof BenchmarkAgentValidationError) {
				return { status: "validation_error" as const, message: err.message };
			}
			throw err;
		}
	}

	getRunCapacity(projectId: string, runId: string) {
		return getBenchmarkRunCapacityDiagnostics(projectId, runId);
	}
}
