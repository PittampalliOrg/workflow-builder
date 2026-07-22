import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";
import { resolveInternalWorkflowPrincipal } from "../../../workflow-mcp-principal";

export const POST: RequestHandler = async ({ request, params }) => {
  if (!validateInternalToken(request)) return error(401, "Unauthorized");

  const body = await request.json().catch(() => null);
  const runtimeAppId =
    body && typeof body === "object" && "runtimeAppId" in body
      ? String(body.runtimeAppId ?? "").trim()
      : "";
  const runtimeInstanceId =
    body && typeof body === "object" && "runtimeInstanceId" in body
      ? String(body.runtimeInstanceId ?? "").trim()
      : "";
  if (!runtimeAppId || !runtimeInstanceId) {
    return error(400, "runtimeAppId and runtimeInstanceId are required");
  }

  const app = getApplicationAdapters();
  const sessionId = params.id.trim();
  const principalResult = await resolveInternalWorkflowPrincipal(
    request,
    app.internalWorkflowPrincipal,
    { requiredScope: "workflow:execute" },
  );
  if (!principalResult.ok) {
    return json(
      {
        authorized: false,
        retryable: false,
        code: "session_principal_unauthorized",
        message: principalResult.error,
        sessionId,
        runtimeAppId,
        runtimeInstanceId,
      },
      { status: principalResult.status },
    );
  }
  const principal = principalResult.principal;
  if (!principal.sessionId || principal.sessionId !== sessionId) {
    return json(
      {
        authorized: false,
        retryable: false,
        code: "session_principal_mismatch",
        message: "Start authority must match the signed session",
        sessionId,
        runtimeAppId,
        runtimeInstanceId,
      },
      { status: 403 },
    );
  }

  const result = await app.sessionRuntimeStartAuthority.authorize(
    sessionId,
    runtimeAppId,
    runtimeInstanceId,
    {
      userId: principal.userId,
      projectId: principal.projectId,
      sessionId: principal.sessionId,
      teamId: principal.capabilities.teamId,
      teamRole: principal.capabilities.teamRole,
    },
  );
  if (result.status === "error") {
    return json(
      {
        authorized: false,
        retryable: result.retryable,
        code: result.code,
        message: result.message,
        sessionId,
        runtimeAppId,
        runtimeInstanceId,
      },
      { status: result.httpStatus },
    );
  }
  return json({
    authorized: true,
    sessionId,
    runtimeAppId,
    runtimeInstanceId,
  });
};
