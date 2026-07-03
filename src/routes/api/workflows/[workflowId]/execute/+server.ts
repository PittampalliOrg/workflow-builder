import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

/**
 * POST /api/workflows/[workflowId]/execute
 *
 * Presentation adapter for starting a workflow run. The application service owns
 * scope checks, trigger-data normalization, execution persistence, Dapr workflow
 * scheduling, and rollback marking on scheduler failure.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const { workflowId } = params;
	if (!locals.session?.userId) return error(401, "Authentication required");

	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		/* empty body ok */
	}

	return workflowExecutionControlResponse(
		await getApplicationAdapters().workflowExecutionControl.executeWorkflow({
			workflowId,
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
