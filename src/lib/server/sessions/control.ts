import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import { resolveAgentRef } from "$lib/server/agents/registry";
import { getSession } from "$lib/server/sessions/registry";

/**
 * Raise a Dapr workflow external event against the session's workflow
 * instance. Session workflows run in the per-agent runtime pod, so route
 * control events through the same runtime-local raise-event endpoint used
 * for user event batches.
 */
export async function raiseSessionEvent(
	sessionId: string,
	eventName: string,
	eventData: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
	const session = await getSession(sessionId);
	if (!session) return { ok: false, status: 404, error: "Session not found" };
	const instanceId = session.daprInstanceId;
	if (!instanceId) {
		return {
			ok: false,
			status: 409,
			error:
				"Session has not been attached to a Dapr workflow instance yet — try again once the session is running.",
		};
	}
	const agent = await resolveAgentRef({
		id: session.agentId,
		version: session.agentVersion ?? undefined,
	});
	if (!agent) return { ok: false, status: 404, error: "Agent not found" };

	const targetAppId = agent.runtimeAppId ?? `agent-runtime-${agent.slug}`;
	const isPerAgent = targetAppId.startsWith("agent-runtime-");
	const bffNamespace = (process.env.POD_NAMESPACE || "workflow-builder").trim();
	const targetNamespace = (
		process.env.AGENT_RUNTIME_NAMESPACE ?? "workflow-builder"
	).trim();
	const invokeTarget =
		isPerAgent && targetNamespace && targetNamespace !== bffNamespace
			? `${targetAppId}.${targetNamespace}`
			: targetAppId;
	const daprEndpoint = getDaprSidecarUrl();
	const res = await daprFetch(
		`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(invokeTarget)}/method/internal/sessions/raise-event`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instanceId, eventName, payload: eventData }),
		},
	);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		return { ok: false, status: res.status, error: text };
	}
	return { ok: true, status: res.status };
}
