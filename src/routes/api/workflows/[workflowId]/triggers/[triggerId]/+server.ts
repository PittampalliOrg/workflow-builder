import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { deactivateWorkflowTrigger } from '$lib/server/lifecycle/trigger-reconciler';

async function scopedTrigger(workflowId: string, triggerId: string, locals: App.Locals) {
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const workflowData = getApplicationAdapters().workflowData;
	const wf = await workflowData.getWorkflowByRef({ workflowId, lookup: 'id' });
	if (!wf || !isResourceInScope(wf, locals.session)) {
		throw error(404, 'Workflow not found');
	}
	const trigger = await workflowData.getWorkflowTrigger({ workflowId, triggerId });
	if (!trigger) throw error(404, 'Trigger not found');
	return trigger;
}

// DELETE — deactivate (tear down backing) then remove the trigger row.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	await scopedTrigger(params.workflowId!, params.triggerId!, locals);
	await deactivateWorkflowTrigger(params.triggerId!); // best-effort teardown
	await getApplicationAdapters().workflowData.deleteWorkflowTrigger(params.triggerId!);
	return json({ success: true });
};
