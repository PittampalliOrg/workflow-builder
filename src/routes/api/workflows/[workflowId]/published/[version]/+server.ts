import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ params }) => {
	const result =
		await getApplicationAdapters().workflowDefinitionCommands.getPublishedWorkflowVersion({
			workflowId: params.workflowId,
			version: params.version,
		});
	if (result.status === 'error') {
		return error(
			result.httpStatus,
			typeof result.body === 'string' ? result.body : 'Published version lookup failed',
		);
	}
	return json(result.body);
};
