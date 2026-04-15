import type { PageServerLoad } from './$types';
import { getWorkflowOpsExecutions } from '$lib/server/workflow-ops';

export const load: PageServerLoad = async ({ url }) => {
	return {
		overview: await getWorkflowOpsExecutions({
			status: url.searchParams.get('status'),
			search: url.searchParams.get('search'),
			rootOnly: url.searchParams.get('rootOnly') === 'true',
			latestOnly: url.searchParams.get('latestOnly') === 'true',
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	};
};
