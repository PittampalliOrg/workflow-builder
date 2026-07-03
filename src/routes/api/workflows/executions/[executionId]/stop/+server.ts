import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

/**
 * POST /api/workflows/executions/[executionId]/stop
 *
 * The vetted way to stop a workflow execution and its per-session children.
 * Body: { mode, reason?, graceMs? }. Fail-closed: 409 if the durable tree did
 * not confirm closure (so the user/UI can retry rather than see a false
 * "cancelled").
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.stopExecution({
			executionId: params.executionId,
			body,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}
