import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsOverview } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ url }) => {
	const overview = await getWorkflowOpsOverview({
		status: url.searchParams.get('status'),
		search: url.searchParams.get('search'),
		limit: Number(url.searchParams.get('limit') ?? 100)
	});
	return json(overview);
};
