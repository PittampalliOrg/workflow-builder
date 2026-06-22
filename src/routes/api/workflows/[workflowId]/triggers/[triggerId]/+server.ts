import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowTriggers } from '$lib/server/db/schema';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { deactivateWorkflowTrigger } from '$lib/server/lifecycle/trigger-reconciler';

async function scopedTrigger(workflowId: string, triggerId: string, locals: App.Locals) {
	if (!db) throw error(503, 'Database not configured');
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const [wf] = await db
		.select({ projectId: workflows.projectId, userId: workflows.userId })
		.from(workflows)
		.where(eq(workflows.id, workflowId))
		.limit(1);
	if (!wf || !isResourceInScope({ projectId: wf.projectId, userId: wf.userId }, locals.session)) {
		throw error(404, 'Workflow not found');
	}
	const [trigger] = await db
		.select()
		.from(workflowTriggers)
		.where(and(eq(workflowTriggers.id, triggerId), eq(workflowTriggers.workflowId, workflowId)))
		.limit(1);
	if (!trigger) throw error(404, 'Trigger not found');
	return trigger;
}

// DELETE — deactivate (tear down backing) then remove the trigger row.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	await scopedTrigger(params.workflowId!, params.triggerId!, locals);
	await deactivateWorkflowTrigger(params.triggerId!); // best-effort teardown
	await db!.delete(workflowTriggers).where(eq(workflowTriggers.id, params.triggerId!));
	return json({ success: true });
};
