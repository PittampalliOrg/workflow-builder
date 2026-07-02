import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const artifacts =
			await getApplicationAdapters().workflowData.listWorkflowBrowserArtifactsByExecutionId(
				params.executionId
			);
		return json({ artifacts });
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Failed to load browser artifacts');
	}
};
