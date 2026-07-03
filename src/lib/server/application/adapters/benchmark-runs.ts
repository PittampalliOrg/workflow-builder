import {
	listBenchmarkRuns,
} from "$lib/server/benchmarks/service";
import { loadCompareData } from "$lib/server/benchmarks/comparison";
import type {
	BenchmarkCompareReadModel,
	BenchmarkRunReadRepository,
	BenchmarkRunSummaryReadModel,
} from "$lib/server/application/ports";

export class LegacyBenchmarkRunReadRepository
	implements BenchmarkRunReadRepository
{
	listRuns(input: {
		projectId: string;
		limit?: number;
		tag?: string | null;
	}): Promise<BenchmarkRunSummaryReadModel[]> {
		return listBenchmarkRuns(input.projectId, input.limit, {
			tag: input.tag,
		});
	}

	loadCompareData(input: {
		projectId: string;
		runIds: string[];
	}): Promise<BenchmarkCompareReadModel> {
		return loadCompareData(input.projectId, input.runIds);
	}
}
