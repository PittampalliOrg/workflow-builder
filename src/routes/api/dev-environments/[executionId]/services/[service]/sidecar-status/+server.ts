import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import {
	allowedSidecarCommands,
	fetchSidecarStatus,
} from "$lib/server/workflows/dev-preview-sidecar";

/**
 * GET /api/dev-environments/[executionId]/services/[service]/sidecar-status
 *
 * B5: proxy one service's dev-sync-sidecar `/__status` to the Dev hub. The pod
 * address comes from the project-scoped workspace-session row (never caller
 * input); unreachable/plugin-mode pods degrade to `status.ok === false`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const environments = await getApplicationAdapters().workflowData.listDevEnvironments({
		projectId: locals.session.projectId,
	});
	const environment = environments.find(
		(e) => e.executionId === params.executionId && e.service === params.service,
	);
	if (!environment) return error(404, "Dev environment service not found");

	const status = await fetchSidecarStatus({ syncUrl: environment.syncUrl });
	return json({
		service: environment.service,
		status,
		allowedCommands: allowedSidecarCommands(environment.service),
	});
};
