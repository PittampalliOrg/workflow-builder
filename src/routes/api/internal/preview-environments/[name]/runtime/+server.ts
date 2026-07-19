import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { guardPreviewMcp, previewMcpError } from "../../guard";

/** Owner-or-admin runtime observation through the tuple-fenced application service. */
export const GET: RequestHandler = async ({ request, params }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
    previewName: params.name,
  });
  if (!guard.ok) return guard.response;
  try {
    return json({
      runtime: await guard.app.vclusterPreviews.observeRuntime({
        name: params.name,
        actorUserId: guard.principal.userId,
      }),
    });
  } catch (cause) {
    return previewMcpError(cause);
  }
};
