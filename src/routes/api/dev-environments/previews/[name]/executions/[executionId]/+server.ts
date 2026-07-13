import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { getApplicationAdapterConfig } from "$lib/server/application/config";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";

/**
 * GET /api/dev-environments/previews/[name]/executions/[executionId]
 *
 * E2 read proxy: one execution's detail inside a Tier-2 preview. Same gating
 * and degradation contract as the executions list route.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  const adapters = getApplicationAdapters();
  if (!adapters.previewDeploymentScope.isControlPlane()) {
    return error(403, "Preview fleet reads are unavailable from a preview deployment");
  }
  if (!getApplicationAdapterConfig().previewReadProxyEnabled) {
    return error(404, "Not found");
  }
  let readModel;
  try {
    readModel = await adapters.previewReadProxy.getPreviewExecution({
      name: params.name,
      actorUserId: locals.session.userId,
      executionId: params.executionId,
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
