import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { startAgentRuntimeSession } from "$lib/server/sessions/agent-runtime-rpc";

/**
 * POST /api/internal/agent-runtime/start
 *
 * Fire-and-forget start of a per-session session_workflow on its sandbox, for
 * the orchestrator's fire-and-poll durable/run dispatch (the orchestrator can't
 * Dapr-invoke per-session sandboxes; the BFF owns the discovery). Internal-token
 * only. Body: { agentAppId, instanceId, payload }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await startAgentRuntimeSession({
		agentAppId: String(b.agentAppId ?? ""),
		instanceId: String(b.instanceId ?? ""),
		payload: b.payload ?? {},
	});
	return json(result);
};
