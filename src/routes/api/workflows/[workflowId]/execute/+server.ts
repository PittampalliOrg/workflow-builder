import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { startWorkflowRun } from "$lib/server/workflows/start-run";
import { assertInScope } from "$lib/server/workflows/project-scope";

/**
 * POST /api/workflows/[workflowId]/execute
 *
 * Presentation adapter for starting a workflow run. The canonical command path
 * is `startWorkflowRun()`, which owns validation, execution persistence, Dapr
 * workflow scheduling, and rollback marking on scheduler failure.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const { workflowId } = params;
	if (!locals.session?.userId) return error(401, "Authentication required");

	const workflow = await getApplicationAdapters().workflowData.getWorkflowByRef({
		workflowId,
		lookup: "id",
	});
	assertInScope(workflow, locals.session, "Workflow not found");

	let body: Record<string, unknown> = {};
	try {
		body = await request.json();
	} catch {
		/* empty body ok */
	}

	const result = await startWorkflowRun({
		workflowId,
		triggerData: (body.input as Record<string, unknown>) ?? {},
		userId: locals.session.userId,
	});
	if (!result.ok) return error(result.status, result.error);

	return json({
		executionId: result.executionId,
		instanceId: result.instanceId,
		workflowId: result.workflowId,
		status: result.status,
	});
};
