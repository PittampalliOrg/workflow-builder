import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const adapters = getApplicationAdapters();
	const route = await adapters.workflowData.getExecutionWorkspaceRoute(params.executionId);
	if (!route) throw error(404, 'Execution not found');

	const scopedByProject =
		route.projectId && locals.session.projectId
			? route.projectId === locals.session.projectId
			: route.userId === locals.session.userId;
	if (!scopedByProject) throw error(404, 'Execution not found');

	throw redirect(
		302,
		adapters.workflowData.buildRuntimePreviewPath({
			executionId: params.executionId,
			workspaceSlug: route.workspaceSlug,
			search: url.search
		})
	);
};
