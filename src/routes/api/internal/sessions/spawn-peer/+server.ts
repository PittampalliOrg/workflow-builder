import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { validateInternalToken } from "$lib/server/internal-auth";

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
	if (!validateInternalToken(request))
		return error(401, "Unauthorized");

	const body = (await request.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;
	const result = await getApplicationAdapters().peerSessionSpawn.spawnPeerSession(
		body,
	);
	if (result.status === "error") {
		return error(result.httpStatus, result.message);
	}
	return json(result.body, { status: result.httpStatus ?? 200 });
};
