import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import { env } from "$env/dynamic/private";
import type { PageServerLoad } from "./$types";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

/**
 * Resolve the launchable service catalog + the seeded `microservice-dev-session`
 * workflow id (the launch engine) for the Dev hub. The grid itself is fetched
 * client-side (polled) from /api/dev-environments.
 */
export const load: PageServerLoad = async ({ locals }) => {
	await requirePlatformAdmin(locals);
	const adapters = getApplicationAdapters();
	const hub = await adapters.workflowData.getDevPreviewHubReadModel({
		projectId: locals.session?.projectId ?? null,
	});
	const config = getApplicationAdapterConfig();
	return {
		...hub,
		previewNativeServices:
			adapters.previewEnvironments.previewNativeServices(),
		previewEnvironment: env.PREVIEW_ENVIRONMENT_ID
			? {
					id: env.PREVIEW_ENVIRONMENT_ID,
					profile: env.PREVIEW_ENVIRONMENT_PROFILE ?? "app-live",
					platformRevision: env.PREVIEW_PLATFORM_REVISION ?? null,
					sourceRevision: env.PREVIEW_SOURCE_REVISION ?? null,
					origin: env.ORIGIN ?? null,
				}
			: null,
		previewRunFeedEnabled: config.previewRunFeedEnabled,
		previewReadProxyEnabled: config.previewReadProxyEnabled,
	};
};
