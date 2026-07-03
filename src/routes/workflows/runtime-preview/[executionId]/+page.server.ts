import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { buildRuntimePreviewPath } from '$lib/server/workflows/runtime-preview-url';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const route = await getApplicationAdapters().workflowData.getExecutionWorkspaceRoute(
		params.executionId
	);
	if (!route) throw error(404, 'Execution not found');

	const scopedByProject =
		route.projectId && locals.session.projectId
			? route.projectId === locals.session.projectId
			: route.userId === locals.session.userId;
	if (!scopedByProject) throw error(404, 'Execution not found');

	throw redirect(302, buildRuntimePreviewPath(params.executionId, route.workspaceSlug, url.search));
};
