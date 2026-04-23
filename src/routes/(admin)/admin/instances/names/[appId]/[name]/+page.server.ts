import type { PageServerLoad } from './$types';
import { getWorkflowOpsWorkflowType } from '$lib/server/workflow-ops';

export const load: PageServerLoad = async ({ params, url }) => {
	const appId = decodeURIComponent(params.appId);
	const name = decodeURIComponent(params.name);
	return {
		workflowType: await getWorkflowOpsWorkflowType(appId, name, {
			latestOnly: url.searchParams.get('latestOnly') === 'true',
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	};
};
