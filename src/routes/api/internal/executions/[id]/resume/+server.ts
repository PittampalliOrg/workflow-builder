import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";
import { guardInternalExecutionAccess } from "../guard";

/**
 * POST /api/internal/executions/[id]/resume
 *
 * Workspace-scoped mirror of the session-authed resume/fork route for the
 * Workflow MCP `resume_workflow_execution` tool (internal token + signed
 * principal, workflow:execute). Starts a FRESH forked run (SW node fork or
 * dynamic-script resume-after-edit); returns the new execution identifiers.
 *
 * Body: { fromNodeId? } — omit to auto-resume from the node in-flight when the
 * source run stopped (SW graphs only; ignored by dynamic-script resume).
 */
export const POST: RequestHandler = async ({ params, request }) => {
	const guard = await guardInternalExecutionAccess(request, params.id, "workflow:execute");
	if (!guard.ok) return guard.res;

	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.resumeExecution({
			executionId: guard.execution.id,
			body,
			userId: guard.execution.userId,
			projectId: guard.execution.projectId,
		}),
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === "error") {
		return json({ error: result.message }, { status: result.httpStatus });
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
}
