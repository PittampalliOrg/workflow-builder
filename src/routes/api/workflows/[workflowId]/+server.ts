import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowDefinitionCommandResult } from '$lib/server/application/workflow-definition-commands';

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
	const body = await request.json();
	const result = await getApplicationAdapters().workflowDefinitionCommands.updateWorkflow({
		workflowId: params.workflowId,
		body,
	});
	return workflowDefinitionCommandResponse(result);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const result = await getApplicationAdapters().workflowDefinitionCommands.deleteWorkflow({
		workflowId: params.workflowId,
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
