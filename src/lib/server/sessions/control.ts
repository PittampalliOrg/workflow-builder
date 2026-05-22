import { daprFetch, getDaprSidecarUrl } from "$lib/server/dapr-client";
import { getSession } from "$lib/server/sessions/registry";
import { resolveSessionRuntimeTarget } from "$lib/server/sessions/runtime-target";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";

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
	const target = await resolveSessionRuntimeTarget(sessionId);
	if (!target) return { ok: false, status: 404, error: "Runtime target not found" };
	const daprEndpoint = getDaprSidecarUrl();
	const res =
		target.runtimeSandboxName || target.appId.startsWith("agent-session-")
			? await daprFetch(
					`${(await waitForAgentWorkflowHostAppReady({ agentAppId: target.appId })).baseUrl}/internal/sessions/raise-event`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ instanceId, eventName, payload: eventData }),
						maxRetries: 0,
					},
				)
			: await daprFetch(
					`${daprEndpoint}/v1.0/invoke/${encodeURIComponent(target.invokeTarget)}/method/internal/sessions/raise-event`,
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
