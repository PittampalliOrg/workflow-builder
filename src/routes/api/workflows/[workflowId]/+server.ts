import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflows } from '$lib/server/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

export const GET: RequestHandler = async ({ params }) => {
	if (!db) {
		// Fallback mock for when DB is not configured
		return json({
			id: params.workflowId,
			name: 'Sample Workflow',
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					position: { x: 250, y: 50 },
					data: { label: 'Start', type: 'trigger', status: 'idle', enabled: true }
				},
				{
					id: 'action-1',
					type: 'action',
					position: { x: 250, y: 200 },
					data: {
						label: 'Process Data',
						type: 'action',
						status: 'idle',
						enabled: true
					}
				}
			],
			edges: [{ id: 'trigger-1-action-1', source: 'trigger-1', target: 'action-1' }]
		});
	}

	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, params.workflowId))
		.limit(1);

	if (!workflow) {
		return error(404, 'Workflow not found');
	}

	return json(workflow);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	if (!db) return error(503, 'Database not configured');

	const body = await request.json();

	const updateData: Record<string, unknown> = {
		name: body.name,
		nodes: body.nodes,
		edges: body.edges,
		updatedAt: new Date(),
	};
	if (body.spec !== undefined) {
		updateData.spec = body.spec;
	}
	const [updated] = await db
		.update(workflows)
		.set(updateData)
		.where(eq(workflows.id, params.workflowId))
		.returning();

	if (!updated) {
		return error(404, 'Workflow not found');
	}

	await syncWorkflowConnectionRefs(params.workflowId, body.nodes, updateData.spec);

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!db) return error(503, 'Database not configured');
	if (!locals.session?.userId) return error(401, 'Authentication required');

	// Workspace-scope this destructive op (was previously unauthenticated).
	const [wf] = await db
		.select({ projectId: workflows.projectId, userId: workflows.userId })
		.from(workflows)
		.where(eq(workflows.id, params.workflowId))
		.limit(1);
	if (!wf) return error(404, 'Workflow not found');
	if (!isResourceInScope({ projectId: wf.projectId, userId: wf.userId }, locals.session)) {
		return error(404, 'Workflow not found');
	}

	// Block delete while any execution of this workflow is still active — deleting
	// the template would orphan the live durable run. Stop it first
	// (POST /api/workflows/executions/[id]/stop).
	const active = await db
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(
			and(
				eq(workflowExecutions.workflowId, params.workflowId),
				inArray(workflowExecutions.status, ['pending', 'running'])
			)
		)
		.limit(1);
	if (active.length > 0) {
		return error(409, 'Stop the running execution before deleting this workflow');
	}

	try {
		await db.delete(workflows).where(eq(workflows.id, params.workflowId));
	} catch (err) {
		// workflow_executions -> workflows FK is ON DELETE no action; terminal
		// execution history blocks the delete. Surface a clear 409 instead of a 500.
		if ((err as { code?: string })?.code === '23503') {
			return error(
				409,
				'This workflow has execution history and cannot be deleted; archive it instead.'
			);
		}
		throw err;
	}

	return json({ success: true });
};
