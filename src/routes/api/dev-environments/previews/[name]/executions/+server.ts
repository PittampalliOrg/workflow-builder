import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";

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
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.isControlPlane()) {
    return error(403, "Preview fleet reads are unavailable from a preview deployment");
  }
  if (!getApplicationAdapterConfig().previewReadProxyEnabled) {
    return error(404, "Not found");
  }
  const limitRaw = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  let readModel;
  try {
    readModel = await adapters.previewReadProxy.listPreviewExecutions({
      name: params.name,
      actorUserId: locals.session.userId,
      limit: Number.isNaN(limitRaw) ? undefined : limitRaw,
      status: url.searchParams.get("status"),
    });
  } catch (cause) {
    if (cause instanceof PreviewAccessDeniedError)
      return error(403, cause.message);
    if (cause instanceof PreviewRuntimeIdentityChangedError)
      return error(409, cause.message);
    throw cause;
  }
  return json(readModel);
};
