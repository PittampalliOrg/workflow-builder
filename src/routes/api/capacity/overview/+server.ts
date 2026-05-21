import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchCapacityObserverSnapshot } from '$lib/server/capacity/observer';
import { buildCapacityBusinessWork } from '$lib/server/capacity/business-work';
import { enrichCapacitySnapshotOwnership } from '$lib/server/capacity/ownership';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	if (!locals.session.projectId) return error(400, 'No active workspace');
	const observer = await fetchCapacityObserverSnapshot();
	let businessWork = null;
	if (observer.available) {
		observer.snapshot = await enrichCapacitySnapshotOwnership(observer.snapshot, {
			projectId: locals.session.projectId,
			workspaceSlug: 'default'
		});
		businessWork = await buildCapacityBusinessWork(observer.snapshot, {
			projectId: locals.session.projectId,
			workspaceSlug: 'default'
		});
	}
	return json({ observer, businessWork });
};
