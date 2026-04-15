import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsWorkflowTypes } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ url }) => {
	return json(
		await getWorkflowOpsWorkflowTypes({
			search: url.searchParams.get('search'),
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	);
};
