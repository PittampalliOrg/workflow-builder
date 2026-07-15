import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

/** Stable path used by a preview browser while its backing Service changes pods. */
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	return json(getApplicationAdapters().runtimeHandoff.current(), {
		headers: { 'cache-control': 'no-store' }
	});
};
