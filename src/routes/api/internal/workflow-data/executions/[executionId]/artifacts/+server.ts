import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { requireInternalOrPreviewControlRead } from "$lib/server/internal-auth";

export { POST } from "../../../../workflows/executions/[executionId]/artifacts/+server";

/**
 * GET /api/internal/workflow-data/executions/[executionId]/artifacts?kind=
 *
 * Internal-token artifact listing for one execution (optionally filtered by
 * kind, e.g. `kind=source-bundle`). Added for E3 archive-on-teardown: the HOST
 * BFF enumerates a preview's un-promoted source bundles through this route
 * before the preview is torn down. Auth: requires INTERNAL_API_TOKEN.
 */
export const GET: RequestHandler = async ({ params, url, request }) => {
  requireInternalOrPreviewControlRead(request);
  const executionId = params.executionId?.trim();
  if (!executionId) return error(400, "executionId required");
  const kind = url.searchParams.get("kind")?.trim() || null;

  const artifacts =
    await getApplicationAdapters().workflowData.listWorkflowArtifactsByExecutionId(
      executionId,
    );
  const filtered = kind ? artifacts.filter((a) => a.kind === kind) : artifacts;
  // Strip inlinePayload: listings stay compact (payloads can be 256KB each);
  // blob content travels via /api/internal/files/[id]/content instead.
  return json({
    artifacts: filtered.map(
      ({ inlinePayload: _inlinePayload, ...rest }) => rest,
    ),
  });
};
