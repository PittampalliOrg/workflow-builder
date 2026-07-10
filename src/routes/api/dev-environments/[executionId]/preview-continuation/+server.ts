import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Continue an authenticated user's app-live PreviewEnvironment. Authorization,
 * project scope, immutable identity, and physical-control calls stay behind the
 * preview-session-continuation application port.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.session?.userId) return error(401, "Authentication required");
  if (!params.executionId) return error(400, "executionId required");

  const result =
    await getApplicationAdapters().previewSessionContinuation.continue({
      executionId: params.executionId,
      userId: locals.session.userId,
      projectId: locals.session.projectId ?? null,
      action: await request.json().catch(() => null),
    });

  if (result.status === "error") return error(result.httpStatus, result.message);
  return json(result.body, { status: result.httpStatus });
};
