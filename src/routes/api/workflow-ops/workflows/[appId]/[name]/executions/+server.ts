import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsExecutions } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ params, url }) => {
	return json(
		await getWorkflowOpsExecutions({
			appId: decodeURIComponent(params.appId),
			name: decodeURIComponent(params.name),
			status: url.searchParams.get('status'),
			search: url.searchParams.get('search'),
			latestOnly: url.searchParams.get('latestOnly') === 'true',
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	);
};
