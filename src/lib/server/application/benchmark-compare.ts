import type {
	BenchmarkCompareReadModel,
	BenchmarkRunReadRepository,
} from "$lib/server/application/ports";

export type BenchmarkCompareApiResult =
	| { status: "ok"; body: BenchmarkCompareReadModel }
	| { status: "bad_request"; message: string }
	| { status: "no_workspace"; message: string };

export class ApplicationBenchmarkCompareService {
	constructor(private readonly benchmarkRuns: BenchmarkRunReadRepository) {}

	async getApiCompare(input: {
		projectId?: string | null;
		runsParam?: string | null;
	}): Promise<BenchmarkCompareApiResult> {
		if (!input.projectId) {
			return { status: "no_workspace", message: "No active workspace" };
		}

		const runIds = (input.runsParam ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		if (runIds.length === 0) {
			return { status: "bad_request", message: "Missing ?runs= parameter" };
		}
		if (runIds.length < 2) {
			return {
				status: "bad_request",
				message: "Provide at least 2 runs to compare",
			};
		}
		if (runIds.length > 4) {
			return {
				status: "bad_request",
				message: "Compare supports at most 4 runs",
			};
		}

		return {
			status: "ok",
			body: await this.benchmarkRuns.loadCompareData({
				projectId: input.projectId,
				runIds: Array.from(new Set(runIds)),
			}),
		};
	}
}
