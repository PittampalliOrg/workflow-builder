/**
 * POST /api/workflows/executions/[executionId]/script-calls/[callId]/skip
 *
 * Skip a pending dynamic-script agent()/workflow() call. Raises the
 * `script.call.control` external event into the running workflow instance; the
 * evaluator resolves that call to null and the run proceeds. Session auth +
 * workspace scope + coordinator-owner guard (like the stop route). Returns 202
 * ("accepted" — the skip takes effect asynchronously). Kill is a separate action
 * (stop the session directly).
 */

import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	return respond(
		await getApplicationAdapters().workflowExecutionControl.skipScriptCall({
			executionId: params.executionId,
			callId: params.callId,
			userId: locals.session.userId,
			projectId: locals.session.projectId ?? null,
		}),
	);
};

function respond(result: WorkflowExecutionControlResult) {
	if (result.status === "error") return error(result.httpStatus, result.message);
	return json(result.body, { status: result.httpStatus ?? 200 });
}
