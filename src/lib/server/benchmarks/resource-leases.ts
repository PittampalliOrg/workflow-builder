export {
	acquireBenchmarkResourceLeases,
	benchmarkResourceLeaseSnapshot,
	__benchmarkResourceLeasesForTest,
	loadBenchmarkResourceCapacityDiagnostics,
	releaseBenchmarkResourceLeases,
	releaseBenchmarkResourceLeasesForRun,
} from "$lib/server/application/adapters/benchmark-resource-leases";

export type {
	BenchmarkResourceCapacityDiagnostic,
	BenchmarkResourceLeaseAdmission,
	BenchmarkResourceLeaseRequest,
	BenchmarkResourceLeaseTypeInput,
} from "$lib/server/application/adapters/benchmark-resource-leases";
