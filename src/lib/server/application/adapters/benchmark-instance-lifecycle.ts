import type {
	BenchmarkInstanceLifecyclePort,
	StartBenchmarkInstanceWorkflowInput,
	TerminateBenchmarkRunInstanceInput,
} from "$lib/server/application/ports";
import {
	startBenchmarkInstanceWorkflow,
	terminateBenchmarkRunInstance,
} from "$lib/server/benchmarks/service";

export class LegacyBenchmarkInstanceLifecycleAdapter
	implements BenchmarkInstanceLifecyclePort
{
	startBenchmarkInstanceWorkflow(input: StartBenchmarkInstanceWorkflowInput) {
		return startBenchmarkInstanceWorkflow(input);
	}

	terminateBenchmarkRunInstance(input: TerminateBenchmarkRunInstanceInput) {
		return terminateBenchmarkRunInstance(input);
	}
}
