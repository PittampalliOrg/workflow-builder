import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflows } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';

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

	const [updated] = await db
		.update(workflows)
		.set({
			name: body.name,
			nodes: body.nodes,
			edges: body.edges,
			updatedAt: new Date()
		})
		.where(eq(workflows.id, params.workflowId))
		.returning();

	if (!updated) {
		return error(404, 'Workflow not found');
	}

	await syncWorkflowConnectionRefs(params.workflowId, body.nodes);

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params }) => {
	if (!db) return error(503, 'Database not configured');

	await db.delete(workflows).where(eq(workflows.id, params.workflowId));

	return json({ success: true });
};
