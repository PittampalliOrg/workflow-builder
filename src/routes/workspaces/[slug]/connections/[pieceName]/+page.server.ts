import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { workspaceProjectId } = await parent();
	const page = await getApplicationAdapters().workflowData.getPieceConnectionDetailPage({
		pieceName: params.pieceName,
		projectId: workspaceProjectId
	});
	if (!page) throw error(404, 'Integration not found');
	return page;
};
