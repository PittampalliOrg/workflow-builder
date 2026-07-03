import { error, json } from "@sveltejs/kit";
import { getApplicationAdapters } from "$lib/server/application";
import { publicSwebenchTestMetadata } from "$lib/server/benchmarks/contamination";
import { publicMlflowRunUrl, publicMlflowTracesUrl } from "$lib/server/benchmarks/mlflow";
import { parseHarnessResult } from "$lib/server/benchmarks/harness-result";
import { parsePatchStats } from "$lib/server/benchmarks/patch-compare";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!locals.session.projectId) return error(404, "Run not found");

	const runId = params.runId;
	const instanceId = decodeURIComponent(params.instanceId ?? "");
	if (!runId || !instanceId) return error(400, "runId and instanceId required");

	let detail;
	try {
		detail = await getApplicationAdapters().workflowData.getBenchmarkRunInstanceDetail({
			runId,
			instanceId,
			projectId: locals.session.projectId,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : "";
		if (/Database not configured/.test(message)) {
			return error(503, "Database not configured");
		}
		throw err;
	}
	if (detail.status === "run_not_found") return error(404, "Run not found");
	if (detail.status === "instance_not_found") {
		return error(404, "Instance not found in this run");
	}

	const parsedHarness = parseHarnessResult(detail.runInstance.harnessResult);
	const postHocEvaluationArtifactsAvailable =
		detail.runInstance.evaluatedAt != null ||
		["resolved", "unresolved", "empty_patch", "error", "timeout", "cancelled"].includes(
			detail.runInstance.evaluationStatus,
		);
	const goldPatch = postHocEvaluationArtifactsAvailable
		? detail.instance.goldPatch
		: null;
	const goldPatchStats = parsePatchStats(goldPatch);
	const hostJobName = extractBenchmarkHostJobName(
		detail.executionIr,
		detail.executionOutput,
	);

	return json({
		runInstance: {
			...detail.runInstance,
			hostJobName,
			mlflowUrl: publicMlflowRunUrl(
				detail.mlflowExperimentId,
				detail.runInstance.mlflowRunId,
			),
			mlflowTracesUrl: publicMlflowTracesUrl(
				detail.mlflowExperimentId,
				(detail.runInstance.traceIds ?? [])[0],
			),
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
	});
};

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

function collectJobNames(value: unknown, depth = 0, seen = new Set<object>()): unknown[] {
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
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
