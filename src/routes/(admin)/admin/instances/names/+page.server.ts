import type { PageServerLoad } from './$types';
import { getWorkflowOpsWorkflowTypes } from '$lib/server/workflow-ops';

export const load: PageServerLoad = async ({ url }) => {
	return {
		overview: await getWorkflowOpsWorkflowTypes({
			search: url.searchParams.get('search'),
			limit: Number(url.searchParams.get('limit') ?? 250)
		})
	};
};
