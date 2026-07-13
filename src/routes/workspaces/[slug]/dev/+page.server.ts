import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
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
	const deploymentScope = adapters.previewDeploymentScope.current();
	return {
		...hub,
		previewNativeServices:
			adapters.previewEnvironments.previewNativeServices(),
		previewEnvironment: deploymentScope.kind === "preview"
			? { id: deploymentScope.preview.name, ...deploymentScope.preview }
			: null,
		previewRunFeedEnabled:
			deploymentScope.kind === "control-plane" && config.previewRunFeedEnabled,
		previewReadProxyEnabled:
			deploymentScope.kind === "control-plane" && config.previewReadProxyEnabled,
	};
};
