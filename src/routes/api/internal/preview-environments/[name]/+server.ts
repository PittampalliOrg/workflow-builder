import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { guardPreviewMcp, previewMcpError } from "../guard";

const FULL_SHA = /^[0-9a-f]{40}$/;

function routeError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

/** Owner-or-admin lifecycle and exact-generation status. */
export const GET: RequestHandler = async ({ request, params }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
    previewName: params.name,
  });
  if (!guard.ok) return guard.response;
  try {
    const access = await guard.app.previewAccess.authorize({
      name: params.name,
      actorUserId: guard.principal.userId,
    });
    return json({
      preview: guard.app.vclusterPreviews.present(access.preview),
    });
  } catch (cause) {
    return previewMcpError(cause);
  }
};

/** Platform-admin, generation-fenced teardown acceptance. */
export const DELETE: RequestHandler = async ({ request, params }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:execute",
    admin: true,
    controlPlane: true,
    previewName: params.name,
  });
  if (!guard.ok) return guard.response;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!body) return routeError(400, "preview_invalid_json", "Invalid JSON body");
  const expectedRequestId =
    typeof body.expectedRequestId === "string"
      ? body.expectedRequestId.trim()
      : "";
  const expectedSourceRevision =
    typeof body.expectedSourceRevision === "string"
      ? body.expectedSourceRevision.trim()
      : "";
  if (
    !expectedRequestId ||
    expectedRequestId.length > 256 ||
    !FULL_SHA.test(expectedSourceRevision)
  ) {
    return routeError(
      400,
      "preview_generation_required",
      "The selected preview generation is required",
    );
  }

  try {
    const result = await guard.app.previewTeardown.teardown({
      name: params.name,
      actorUserId: guard.principal.userId,
      expectedRequestId,
      expectedSourceRevision,
      projectId: guard.principal.projectId,
      ...(body.discardUnarchived === true
        ? { discardUnarchived: true }
        : body.forceFailed === true
          ? { forceFailed: true }
          : {}),
    });
    const preview = guard.app.vclusterPreviews.present(result.preview);
    return json(
      {
        preview,
        teardown: result.ticket,
        ...(result.archive ? { archive: result.archive } : {}),
      },
      preview.phase === "absent"
        ? { status: 200 }
        : { status: 202, headers: { "retry-after": "5" } },
    );
  } catch (cause) {
    return previewMcpError(cause);
  }
};
