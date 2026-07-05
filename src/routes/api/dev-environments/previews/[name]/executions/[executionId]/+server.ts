import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

/**
 * GET /api/dev-environments/previews/[name]/executions/[executionId]
 *
 * E2 read proxy: one execution's detail inside a Tier-2 preview. Same gating
 * and degradation contract as the executions list route.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!getApplicationAdapterConfig().previewReadProxyEnabled) {
		return error(404, "Not found");
	}
	const readModel = await getApplicationAdapters().previewReadProxy.getPreviewExecution({
		name: params.name,
		executionId: params.executionId,
	});
	if (!readModel) return error(404, "Unknown preview");
	return json(readModel);
};
