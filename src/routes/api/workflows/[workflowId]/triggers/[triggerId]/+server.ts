import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowTriggerLifecycleCommandResult } from '$lib/server/application/workflow-trigger-lifecycle';

// DELETE — deactivate (tear down backing) then remove the trigger row.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const result = await getApplicationAdapters().workflowTriggerLifecycle.deleteTrigger({
		workflowId: params.workflowId!,
		triggerId: params.triggerId!,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	return workflowTriggerLifecycleResponse(result);
};

function workflowTriggerLifecycleResponse(result: WorkflowTriggerLifecycleCommandResult) {
	if (result.status === 'error') {
		if (typeof result.body === 'string') return error(result.httpStatus, result.body);
		return json(result.body, { status: result.httpStatus });
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
}
