import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflows, workflowTriggers } from '$lib/server/db/schema';
import { isResourceInScope } from '$lib/server/workflows/project-scope';
import { deactivateWorkflowTrigger } from '$lib/server/lifecycle/trigger-reconciler';

// POST — deactivate a trigger: tear down its backing (stops firing). Keeps the row.
export const POST: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const [wf] = await db
		.select({ projectId: workflows.projectId, userId: workflows.userId })
		.from(workflows)
		.where(eq(workflows.id, params.workflowId!))
		.limit(1);
	if (!wf || !isResourceInScope({ projectId: wf.projectId, userId: wf.userId }, locals.session)) {
		return error(404, 'Workflow not found');
	}
	const [trigger] = await db
		.select({ id: workflowTriggers.id })
		.from(workflowTriggers)
		.where(and(eq(workflowTriggers.id, params.triggerId!), eq(workflowTriggers.workflowId, params.workflowId!)))
		.limit(1);
	if (!trigger) return error(404, 'Trigger not found');

	const result = await deactivateWorkflowTrigger(params.triggerId!);
	if (!result.ok) return json({ error: result.error }, { status: 502 });
	return json({ success: true, status: result.status });
};
