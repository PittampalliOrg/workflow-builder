import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchCapacityObserverSnapshot } from '$lib/server/capacity/observer';
import { buildCapacityCoverageSummary } from '$lib/server/capacity/coverage';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId) return error(400, 'No active workspace');
	const observer = await fetchCapacityObserverSnapshot();
	return json({ observer, coverage: buildCapacityCoverageSummary(observer) });
};
