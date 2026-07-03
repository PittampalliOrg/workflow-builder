import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId) return error(400, 'No active workspace');
	const result = await getApplicationAdapters().capacityOverview.getOverview({
		projectId: locals.session.projectId,
		workspaceSlug: 'default'
	});
	return json({
		observer: result.observer,
		businessWork: result.observer.available ? result.businessWork : null
	});
};
