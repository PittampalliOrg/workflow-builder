import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { guardPreviewMcp } from "../guard";

/** Current BFF-owned catalog; no cluster or preview credential is exposed. */
export const GET: RequestHandler = async ({ request }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
  });
  if (!guard.ok) return guard.response;
  return json({
    services: await guard.app.workflowData.listDevPreviewServices(),
  });
};
