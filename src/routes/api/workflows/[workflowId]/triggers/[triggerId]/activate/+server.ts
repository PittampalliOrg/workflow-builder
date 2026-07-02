import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { activateWorkflowTrigger } from '$lib/server/lifecycle/trigger-reconciler';

// POST — activate a trigger: provision its backing (Argo EventSource+Sensor, …)
// so the workflow fires whenever the signal arrives.
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const workflowData = getApplicationAdapters().workflowData;
	const wf = await workflowData.getWorkflowByRef({ workflowId: params.workflowId!, lookup: 'id' });
	if (!wf || !isResourceInScope(wf, locals.session)) {
		return error(404, 'Workflow not found');
	}
	const trigger = await workflowData.getWorkflowTrigger({
		workflowId: params.workflowId!,
		triggerId: params.triggerId!,
	});
	if (!trigger) return error(404, 'Trigger not found');

	const result = await activateWorkflowTrigger(params.triggerId!);
	if (!result.ok) return json({ error: result.error }, { status: 502 });
	return json({ success: true, status: result.status });
};
