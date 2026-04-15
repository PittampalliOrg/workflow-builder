import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsWorkflowType } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ params, url }) => {
	return json(
		await getWorkflowOpsWorkflowType(decodeURIComponent(params.appId), decodeURIComponent(params.name), {
			latestOnly: url.searchParams.get('latestOnly') === 'true',
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	);
};
