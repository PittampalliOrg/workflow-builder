import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { syncWorkflowConnectionRefs } from '$lib/server/workflow-connections';
export const GET: RequestHandler = async ({ locals, url }) => {
	const limit = parseInt(url.searchParams.get('limit') || '50');
	const projectOnly = url.searchParams.get('projectOnly') === '1';
	if (projectOnly && !locals.session?.projectId) return json([]);
	const result = await getApplicationAdapters().workflowData.listWorkflows({
		limit,
		projectId: projectOnly ? locals.session?.projectId : null,
	});

	return json(result);
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId)
		return error(400, 'No active workspace — cannot create workflow');

	const body = await request.json();

	const workflow = await getApplicationAdapters().workflowData.createWorkflowDefinition({
		name: body.name || 'Untitled Workflow',
		nodes: body.nodes || [],
		edges: body.edges || [],
		engineType: body.engineType || 'dapr',
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		spec: body.spec,
	});

	await syncWorkflowConnectionRefs(workflow.id, body.nodes || [], body.spec);

	return json(workflow, { status: 201 });
};
