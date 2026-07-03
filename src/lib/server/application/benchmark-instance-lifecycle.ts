import type {
	BenchmarkInstanceLifecyclePort,
	StartBenchmarkInstanceWorkflowInput,
	TerminateBenchmarkRunInstanceInput,
} from "$lib/server/application/ports";

export class ApplicationBenchmarkInstanceLifecycleService {
	constructor(private readonly lifecycle: BenchmarkInstanceLifecyclePort) {}

	startBenchmarkInstanceWorkflow(input: StartBenchmarkInstanceWorkflowInput) {
		return this.lifecycle.startBenchmarkInstanceWorkflow(input);
	}

	terminateBenchmarkRunInstance(input: TerminateBenchmarkRunInstanceInput) {
		return this.lifecycle.terminateBenchmarkRunInstance(input);
	}
}
