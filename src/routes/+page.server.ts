import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Dashboard home. Greets the user by name + surfaces their five most
 * recent sessions and five most recent workflow runs. Unauthenticated
 * callers still land here — they see the CTA cards but an empty recents
 * strip.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) {
		return { user: null, recentSessions: [], recentRuns: [] };
	}

	return getApplicationAdapters().workflowData.getHomePageReadModel({
		userId: locals.session.userId,
		projectId: locals.session.projectId,
		limit: 5,
	});
};
