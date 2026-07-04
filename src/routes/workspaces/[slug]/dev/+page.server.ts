import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import type { PageServerLoad } from "./$types";

/**
 * Resolve the launchable service catalog + the seeded `microservice-dev-session`
 * workflow id (the launch engine) for the Dev hub. The grid itself is fetched
 * client-side (polled) from /api/dev-environments.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const hub = await getApplicationAdapters().workflowData.getDevPreviewHubReadModel({
		projectId: locals.session?.projectId ?? null,
	});
	return {
		...hub,
		crossPreviewFeedEnabled: getApplicationAdapterConfig().crossPreviewFeedEnabled,
	};
};
