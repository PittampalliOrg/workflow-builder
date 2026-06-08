import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { terminateAgentRuntimeSession } from "$lib/server/sessions/agent-runtime-rpc";

/**
 * POST /api/internal/agent-runtime/terminate
 *
 * Terminate a per-session session_workflow on its sandbox (orchestrator
 * cancel / timeout in fire-and-poll dispatch). Best-effort; internal-token only.
 * Body: { agentAppId, instanceId, reason }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await terminateAgentRuntimeSession({
		agentAppId: String(b.agentAppId ?? ""),
		instanceId: String(b.instanceId ?? ""),
		reason: typeof b.reason === "string" ? b.reason : undefined,
	});
	return json(result);
};
