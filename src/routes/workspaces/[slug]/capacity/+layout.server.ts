import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The workspace `[slug]` parent layout already validates that the caller
 * is a member of the project for `params.slug`. We re-check the auth
 * session here so an unauthenticated request gets a 401 immediately
 * instead of streaming an SSE shell that will fail.
 */
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	return {};
};
