import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireInternal } from "$lib/server/internal-auth";
import { pollAgentRuntimeStatus } from "$lib/server/sessions/agent-runtime-rpc";

/**
 * POST /api/internal/agent-runtime/status
 *
 * Poll a per-session session_workflow's runtime status + serialized output for
 * the orchestrator's fire-and-poll durable/run dispatch. Internal-token only.
 * Body: { agentAppId, instanceId } -> { complete, runtimeStatus, output, missing }.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);
	const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	const result = await pollAgentRuntimeStatus({
		agentAppId: String(b.agentAppId ?? ""),
		instanceId: String(b.instanceId ?? ""),
	});
	return json(result);
};
