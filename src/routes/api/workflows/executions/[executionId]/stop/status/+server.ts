import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

/**
 * GET /api/workflows/executions/[executionId]/stop/status
 *
 * Poll the convergence of a previously-requested stop (the UI shows "Stopping…"
 * after a 202 and polls this until `state:"confirmed"`). Idempotent: finalizes
 * the DB + reaps sandboxes once the durable tree is confirmed terminal.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.getStopStatus({
			executionId: params.executionId,
			projectId: locals.session.projectId ?? null,
			userId: locals.session.userId,
		}),
	);
};

function workflowExecutionControlResponse(result: WorkflowExecutionControlResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}
