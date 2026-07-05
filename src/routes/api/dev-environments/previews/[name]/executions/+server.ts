import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";

/**
 * GET /api/dev-environments/previews/[name]/executions?limit=&status=
 *
 * E2 read proxy: recent workflow executions INSIDE one Tier-2 preview vcluster,
 * fetched from the preview BFF's internal read API. Session-gated + flagged
 * (PREVIEW_READ_PROXY_ENABLED, 404 when off — same shape as the E1 feed
 * route). Unknown previews 404; a reachable-but-failing preview degrades to
 * `result.ok === false` with HTTP 200, never a 500.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.session?.userId) return error(401, "Authentication required");
	if (!getApplicationAdapterConfig().previewReadProxyEnabled) {
		return error(404, "Not found");
	}
	const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const readModel = await getApplicationAdapters().previewReadProxy.listPreviewExecutions({
		name: params.name,
		limit: Number.isNaN(limitRaw) ? undefined : limitRaw,
		status: url.searchParams.get("status"),
	});
	if (!readModel) return error(404, "Unknown preview");
	return json(readModel);
};
