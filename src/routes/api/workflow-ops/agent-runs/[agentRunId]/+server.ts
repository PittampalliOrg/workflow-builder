import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getWorkflowOpsAgentRun } from '$lib/server/workflow-ops';

export const GET: RequestHandler = async ({ params }) => {
	return json(await getWorkflowOpsAgentRun(params.agentRunId));
};
