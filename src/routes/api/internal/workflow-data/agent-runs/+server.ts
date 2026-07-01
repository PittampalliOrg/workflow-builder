import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type {
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowAgentRunMode,
} from "$lib/server/application/ports";
import { requireInternal } from "$lib/server/internal-auth";

const VALID_MODES = new Set<WorkflowAgentRunMode>(["run", "plan", "execute_plan"]);

function normalizeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const body = (await request.json().catch(() => null)) as Partial<UpsertWorkflowAgentRunScheduledInput> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return error(400, "JSON object body required");
	}

	const id = normalizeString(body.id);
	const workflowExecutionId = normalizeString(body.workflowExecutionId);
	const workflowId = normalizeString(body.workflowId);
	const nodeId = normalizeString(body.nodeId);
	const agentWorkflowId = normalizeString(body.agentWorkflowId);
	const daprInstanceId = normalizeString(body.daprInstanceId);
	const parentExecutionId = normalizeString(body.parentExecutionId);
	const mode = normalizeString(body.mode) ?? "run";
	if (
		!id ||
		!workflowExecutionId ||
		!workflowId ||
		!nodeId ||
		!agentWorkflowId ||
		!daprInstanceId ||
		!parentExecutionId
	) {
		return error(
			400,
			"id, workflowExecutionId, workflowId, nodeId, agentWorkflowId, daprInstanceId, and parentExecutionId are required",
		);
	}
	if (!VALID_MODES.has(mode as WorkflowAgentRunMode)) {
		return error(400, "mode must be one of run, plan, execute_plan");
	}

	const result = await getApplicationAdapters().workflowData.upsertScheduledAgentRun({
		id,
		workflowExecutionId,
		workflowId,
		nodeId,
		mode: mode as WorkflowAgentRunMode,
		agentWorkflowId,
		daprInstanceId,
		parentExecutionId,
		workspaceRef: normalizeString(body.workspaceRef),
		artifactRef: normalizeString(body.artifactRef),
	});

	return json({ ok: true, ...result });
};
