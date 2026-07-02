import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';
import { isResourceInScope } from '$lib/server/workflows/project-scope';

export const GET: RequestHandler = async ({ params }) => {
	const workflow = await getApplicationAdapters().workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id',
	});

	if (!workflow) {
		return error(404, 'Workflow not found');
	}

	return json(workflow);
};

export const PUT: RequestHandler = async ({ params, request }) => {
	const body = (await request.json()) as {
		name?: string;
		nodes?: unknown[];
		edges?: unknown[];
		spec?: unknown;
	};

	const updateData: {
		name?: string;
		nodes: unknown[] | undefined;
		edges: unknown[] | undefined;
		spec?: unknown;
	} = {
		name: body.name,
		nodes: body.nodes,
		edges: body.edges,
	};
	if (body.spec !== undefined) {
		updateData.spec = body.spec;
	}
	const updated = await getApplicationAdapters().workflowData.updateWorkflowDefinition(
		params.workflowId,
		updateData,
	);

	if (!updated) {
		return error(404, 'Workflow not found');
	}

	await syncWorkflowConnectionRefs(params.workflowId, body.nodes, updateData.spec);

	return json(updated);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const workflowData = getApplicationAdapters().workflowData;

	// Workspace-scope this destructive op (was previously unauthenticated).
	const wf = await workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id',
	});
	if (!wf) return error(404, 'Workflow not found');
	if (!isResourceInScope(wf, locals.session)) {
		return error(404, 'Workflow not found');
	}

	// Block delete while any execution of this workflow is still active — deleting
	// the template would orphan the live durable run. Stop it first
	// (POST /api/workflows/executions/[id]/stop).
	if (await workflowData.hasActiveWorkflowExecutions(params.workflowId)) {
		return error(409, 'Stop the running execution before deleting this workflow');
	}

	try {
		await workflowData.deleteWorkflowDefinition(params.workflowId);
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
