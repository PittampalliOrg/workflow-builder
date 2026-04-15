import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsDetail } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getWorkflowOpsDetail(params.instanceId);
	return json(detail);
};
