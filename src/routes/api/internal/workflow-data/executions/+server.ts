import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	CreateWorkflowExecutionInput,
	WorkflowExecutionStatus,
} from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

const EXECUTION_STATUSES = new Set(["pending", "running", "success", "error", "cancelled"]);

function asObject(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return asOptionalString(value);
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireInternal(request);
	const staleOlderThanMinutes = url.searchParams.get("staleOlderThanMinutes");
	if (!staleOlderThanMinutes) return error(400, "staleOlderThanMinutes query required");
	const olderThanMinutes = Number(staleOlderThanMinutes);
	if (!Number.isFinite(olderThanMinutes) || olderThanMinutes < 0) {
		return error(400, "staleOlderThanMinutes must be a non-negative number");
	}
	const executions = await getApplicationAdapters().workflowData.listStaleRunningExecutions({
		olderThanMinutes,
	});
	return json({ executions });
};

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = asObject(await request.json().catch(() => null));
	if (!body) return error(400, "JSON object body required");

	const workflowId = asOptionalString(body.workflowId);
	const userId = asOptionalString(body.userId);
	if (!workflowId) return error(400, "workflowId required");
	if (!userId) return error(400, "userId required");

	const status = asOptionalString(body.status) ?? "running";
	if (!EXECUTION_STATUSES.has(status)) return error(400, "unsupported execution status");
	const id = asOptionalString(body.id);

	const input: CreateWorkflowExecutionInput = {
		...(id ? { id } : {}),
		workflowId,
		userId,
		projectId: asNullableString(body.projectId),
		status: status as WorkflowExecutionStatus,
		phase: asNullableString(body.phase),
		progress: typeof body.progress === "number" ? body.progress : null,
		input: asObject(body.input) ?? {},
		output: body.output,
		executionIr: body.executionIr,
		executionIrVersion: asNullableString(body.executionIrVersion),
		triggerSource: asOptionalString(body.triggerSource),
		rerunOfExecutionId: asOptionalString(body.rerunOfExecutionId),
		rerunSourceInstanceId: asOptionalString(body.rerunSourceInstanceId),
		resumeFromNode: asOptionalString(body.resumeFromNode),
		workflowSessionId: asNullableString(body.workflowSessionId),
	};

	const result = await getApplicationAdapters().workflowData.createWorkflowExecution(input);
	return json(result);
};
