import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowTriggerManagementCommandResult } from '$lib/server/application/workflow-trigger-management';

// GET — list a workflow's triggers.
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const result = await getApplicationAdapters().workflowTriggerManagement.listTriggers({
		workflowId: params.workflowId!,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	return workflowTriggerManagementResponse(result);
};

// POST — create a trigger (inactive). Activate separately via …/[id]/activate.
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const body = await request.json().catch(() => ({}));
	const result = await getApplicationAdapters().workflowTriggerManagement.createTrigger({
		workflowId: params.workflowId!,
		userId: locals.session!.userId,
		projectId: locals.session.projectId,
		body,
	});
	return workflowTriggerManagementResponse(result);
};

function workflowTriggerManagementResponse(result: WorkflowTriggerManagementCommandResult) {
	if (result.status === 'error') {
		if (typeof result.body === 'string') return error(result.httpStatus, result.body);
		return json(result.body, { status: result.httpStatus });
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
}
