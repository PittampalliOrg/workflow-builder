import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { applyBenchmarkInstanceHostExecutionUpdate } from "$lib/server/benchmarks/service";
import { requireInternal } from "$lib/server/internal-auth";

function stringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const out = value.filter(
		(entry): entry is string => typeof entry === "string" && !!entry.trim(),
	);
	return out.length > 0 ? out : null;
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export const POST: RequestHandler = async ({ request, params }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const instance = await applyBenchmarkInstanceHostExecutionUpdate({
		runId: params.runId,
		instanceId: params.instanceId,
		status: body.status,
		hostExecutionId:
			typeof body.hostExecutionId === "string"
				? body.hostExecutionId
				: typeof body.executionId === "string"
					? body.executionId
					: null,
		daprInstanceId:
			typeof body.daprInstanceId === "string" ? body.daprInstanceId : null,
		jobName: typeof body.jobName === "string" ? body.jobName : null,
		output: body.output ?? body.result,
		error: typeof body.error === "string" ? body.error : null,
		sandboxName:
			typeof body.sandboxName === "string" ? body.sandboxName : null,
		workspaceRef:
			typeof body.workspaceRef === "string" ? body.workspaceRef : null,
		traceIds: stringArray(body.traceIds),
		inferenceEnvironment: record(body.inferenceEnvironment),
		terminationReason:
			typeof body.terminationReason === "string"
				? body.terminationReason
				: null,
		retryAfterSeconds:
			typeof body.retryAfterSeconds === "number"
				? body.retryAfterSeconds
				: null,
	});
	if (!instance) return error(404, "Benchmark instance not found");
	return json({ success: true, instance });
};
