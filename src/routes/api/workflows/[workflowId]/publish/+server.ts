import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const POST: RequestHandler = async ({ params }) => {
	const result = await getApplicationAdapters().workflowDefinitionCommands.publishWorkflow({
		workflowId: params.workflowId,
	});
	if (result.status === 'error') {
		return error(
			result.httpStatus,
			typeof result.body === 'string' ? result.body : 'Workflow publish failed',
		);
	}
	return json(result.body);
};
