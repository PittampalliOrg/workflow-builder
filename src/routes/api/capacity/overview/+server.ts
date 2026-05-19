import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchCapacityObserverSnapshot } from '$lib/server/capacity/observer';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId) return error(400, 'No active workspace');
	return json({ observer: await fetchCapacityObserverSnapshot() });
};
