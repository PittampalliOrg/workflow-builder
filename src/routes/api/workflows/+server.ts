import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowDefinitionCommandResult } from '$lib/server/application/workflow-definition-commands';

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

	const result = await getApplicationAdapters().workflowDefinitionCommands.createWorkflow({
		body,
		userId: locals.session.userId,
		projectId: locals.session.projectId,
	});
	return workflowDefinitionCommandResponse(result);
};

function workflowDefinitionCommandResponse(result: WorkflowDefinitionCommandResult) {
	if (result.status === 'error') {
		if (typeof result.body === 'string') return error(result.httpStatus, result.body);
		return json(result.body, { status: result.httpStatus });
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
}
