import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * GET /api/dev-environments/[executionId]/services/[service]/sidecar-status
 *
 * B5: proxy one service's dev-sync-sidecar `/__status` to the Dev hub. The pod
 * address comes from the project-scoped workspace-session row (never caller
 * input); unreachable/plugin-mode pods degrade to `status.ok === false`.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	const result = await getApplicationAdapters().devPreviewSidecar.status({
		executionId: params.executionId,
		service: params.service,
		projectId: locals.session.projectId,
	});
	if (!result) return error(404, "Dev environment service not found");
	return json(result);
};
