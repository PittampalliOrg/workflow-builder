import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";
import { resolveInternalWorkflowPrincipal } from "../../workflow-mcp-principal";

/**
 * Internal endpoint for peer-agent delegation via the `CallAgent` tool
 * on `dapr-agent-py`. The parent agent's tool hits this instead of
 * dispatching a raw Dapr workflow: that way the child gets a real
 * `sessions` row (visible in the UI), proper parent linkage via
 * `parentExecutionId`, and rides the normal application peer-session
 * spawn pipeline.
 *
 * Idempotent: the caller passes a deterministic `sessionId`
 * (`ca-<uuid>-<slug>`), so on Dapr activity replay a second call with
 * the same id short-circuits to the existing row. The Dapr workflow
 * dispatch is also idempotent (same instance id).
 *
 * Body:
 *   {
 *     sessionId: string,          // deterministic, ≤64 chars
 *     peerAgentId: string,        // DB id of the peer agent
 *     prompt: string,             // initialMessage for the child
 *     parentSessionId?: string,   // for lineage (stored as parentExecutionId)
 *     parentInstanceId?: string,  // Dapr workflow instance of parent
 *     title?: string,
 *   }
 *
 * Response:
 *   { sessionId, agentId, agentVersion, daprInstanceId, natsSubject, reused }
 */
export const POST: RequestHandler = async ({ request }) => {
  if (!validateInternalToken(request)) return error(401, "Unauthorized");

  const app = getApplicationAdapters();
	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
  const parentSessionId =
    typeof body.parentSessionId === "string" ? body.parentSessionId.trim() : "";
  const headerSessionId = request.headers.get("x-wfb-session-id")?.trim() || "";
  if (
    headerSessionId &&
    parentSessionId &&
    headerSessionId !== parentSessionId
  ) {
    return error(403, "Peer spawn session lineage does not match the request");
  }
  const principalResult = await resolveInternalWorkflowPrincipal(
    request,
    app.internalWorkflowPrincipal,
    {
      requiredScope: "workflow:execute",
      ...(parentSessionId
        ? {
            legacyResource: {
              kind: "session" as const,
              id: parentSessionId,
            },
          }
        : {}),
    },
  );
  if (!principalResult.ok) {
    return error(principalResult.status, principalResult.error);
  }
  const principal = principalResult.principal;
  if (!principal.sessionId || !principal.capabilities) {
    return error(403, "Peer spawn requires a signed platform session");
  }

  const result = await app.peerSessionSpawn.spawnPeerSession(
		body,
    {
      userId: principal.userId,
      projectId: principal.projectId,
      sessionId: principal.sessionId,
      capabilities: principal.capabilities,
    },
    { kind: "call_agent" },
	);
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
};
