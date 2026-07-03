import { publicSwebenchTestMetadata } from "$lib/server/benchmarks/contamination";
import {
	parseHarnessResult,
	type ParsedHarnessResult,
} from "$lib/server/benchmarks/harness-result";
import { parsePatchStats } from "$lib/server/benchmarks/patch-compare";
import type {
	BenchmarkRunInstanceDetailReadModel,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type BenchmarkRunInstanceDetailMlflowLinks = {
	runUrl(input: {
		experimentId: string | null | undefined;
		runId: string | null | undefined;
	}): string | null;
	tracesUrl(input: {
		experimentId: string | null | undefined;
		traceId: string | null | undefined;
	}): string | null;
};

export type BenchmarkRunInstanceDetailResponseBody = {
	runInstance: Record<string, unknown>;
	instance: {
		repo: string | null;
		baseCommit: string | null;
		problemStatement: string | null;
		hintsText: string | null;
		testMetadata: Record<string, unknown>;
		metadata: Record<string, unknown> | null;
	};
	goldPatch: string | null;
	goldPatchStats: {
		addedLines: number;
		removedLines: number;
		filesTouched: number;
	};
	parsedHarness: ParsedHarnessResult;
	postHocEvaluationArtifactsAvailable: boolean;
};

export type BenchmarkRunInstanceDetailResult =
	| { status: "ok"; body: BenchmarkRunInstanceDetailResponseBody }
	| { status: "bad_request"; message: string }
	| { status: "run_not_found"; message: string }
	| { status: "instance_not_found"; message: string };

export class ApplicationBenchmarkRunInstanceDetailService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getBenchmarkRunInstanceDetail">;
			mlflowLinks: BenchmarkRunInstanceDetailMlflowLinks;
		},
	) {}

	async getDetail(input: {
		runId: string;
		instanceId: string;
		projectId?: string | null;
	}): Promise<BenchmarkRunInstanceDetailResult> {
		const runId = input.runId.trim();
		const instanceId = input.instanceId.trim();
		if (!runId || !instanceId) {
			return {
				status: "bad_request",
				message: "runId and instanceId required",
			};
		}
		if (!input.projectId) return runNotFound();

		const detail = await this.deps.workflowData.getBenchmarkRunInstanceDetail({
			runId,
			instanceId,
			projectId: input.projectId,
		});

		if (detail.status === "run_not_found") return runNotFound();
		if (detail.status === "instance_not_found") {
			return {
				status: "instance_not_found",
				message: "Instance not found in this run",
			};
		}

		return {
			status: "ok",
			body: this.toResponseBody(detail),
		};
	}

	private toResponseBody(
		detail: Extract<BenchmarkRunInstanceDetailReadModel, { status: "ok" }>,
	): BenchmarkRunInstanceDetailResponseBody {
		const parsedHarness = parseHarnessResult(detail.runInstance.harnessResult);
		const postHocEvaluationArtifactsAvailable =
			detail.runInstance.evaluatedAt != null ||
			[
				"resolved",
				"unresolved",
				"empty_patch",
				"error",
				"timeout",
				"cancelled",
			].includes(detail.runInstance.evaluationStatus);
		const goldPatch = postHocEvaluationArtifactsAvailable
			? detail.instance.goldPatch
			: null;
		const goldPatchStats = parsePatchStats(goldPatch);
		const firstTraceId = Array.isArray(detail.runInstance.traceIds)
			? detail.runInstance.traceIds[0]
			: null;

		return {
			runInstance: {
				...detail.runInstance,
				hostJobName: extractBenchmarkHostJobName(
					detail.executionIr,
					detail.executionOutput,
				),
				mlflowUrl: this.deps.mlflowLinks.runUrl({
					experimentId: detail.mlflowExperimentId,
					runId: detail.runInstance.mlflowRunId,
				}),
				mlflowTracesUrl: this.deps.mlflowLinks.tracesUrl({
					experimentId: detail.mlflowExperimentId,
					traceId: firstTraceId,
				}),
			},
			instance: {
				repo: detail.instance.repo,
				baseCommit: detail.instance.baseCommit,
				problemStatement: detail.instance.problemStatement,
				hintsText: detail.instance.hintsText,
				testMetadata: publicSwebenchTestMetadata(detail.instance.testMetadata),
				metadata: detail.instance.metadata,
			},
			goldPatch,
			goldPatchStats: {
				addedLines: goldPatchStats.addedLines,
				removedLines: goldPatchStats.removedLines,
				filesTouched: goldPatchStats.filesTouched.length,
			},
			parsedHarness,
			postHocEvaluationArtifactsAvailable,
		};
	}
}

function runNotFound(): BenchmarkRunInstanceDetailResult {
	return { status: "run_not_found", message: "Run not found" };
}

function extractBenchmarkHostJobName(
	executionIr: unknown,
	executionOutput: unknown,
): string | null {
	const candidates: unknown[] = [];
	for (const source of [executionIr, executionOutput]) {
		const root = asRecord(source);
		if (!root) continue;
		candidates.push(root.jobName, root.job_name, root.kubernetesJobName);
		for (const key of ["dispatch", "hostExecution", "job", "kubernetes"] as const) {
			const nested = asRecord(root[key]);
			if (!nested) continue;
			candidates.push(nested.jobName, nested.job_name, nested.kubernetesJobName);
		}
		candidates.push(...collectJobNames(root));
	}
	for (const candidate of candidates) {
		const value = asNonEmptyString(candidate);
		if (value) return value;
	}
	return null;
}

function collectJobNames(
	value: unknown,
	depth = 0,
	seen = new Set<object>(),
): unknown[] {
	if (depth > 6 || value == null || typeof value !== "object") return [];
	if (seen.has(value)) return [];
	seen.add(value);
	const out: unknown[] = [];
	if (Array.isArray(value)) {
		for (const item of value) out.push(...collectJobNames(item, depth + 1, seen));
		return out;
	}
	for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
		if (key === "jobName" || key === "job_name" || key === "kubernetesJobName") {
			out.push(nested);
		}
		out.push(...collectJobNames(nested, depth + 1, seen));
	}
	return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asNonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}
