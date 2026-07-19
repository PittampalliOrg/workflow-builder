import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { guardPreviewMcp, previewMcpError } from "../../../guard";

const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

function routeError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, { status });
}

/** Signed-ticket convergence read; the HMAC root remains behind the application port. */
export const POST: RequestHandler = async ({ request, params }) => {
  const guard = await guardPreviewMcp(request, {
    requiredScope: "workflow:read",
    admin: true,
    controlPlane: true,
    previewName: params.name,
  });
  if (!guard.ok) return guard.response;
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const environmentUid =
    typeof body?.environmentUid === "string" ? body.environmentUid : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  const sourceRevision =
    typeof body?.sourceRevision === "string" ? body.sourceRevision : "";
  const signature = typeof body?.signature === "string" ? body.signature : "";
  if (
    !environmentUid ||
    environmentUid.length > 128 ||
    !requestId ||
    requestId.length > 256 ||
    !SHA.test(sourceRevision) ||
    !SIGNATURE.test(signature) ||
    (typeof body?.name === "string" && body.name !== params.name)
  ) {
    return routeError(
      400,
      "preview_teardown_ticket_invalid",
      "A valid teardown ticket for this preview is required",
    );
  }
  const ticket = {
    name: params.name,
    environmentUid,
    requestId,
    sourceRevision,
    signature,
  };
  try {
    const teardown = await guard.app.vclusterPreviews.teardownStatus(ticket);
    return json(
      { teardown, ticket },
      teardown.phase === "pending"
        ? { status: 202, headers: { "retry-after": "5" } }
        : { status: 200 },
    );
  } catch (cause) {
    return previewMcpError(cause);
  }
};
