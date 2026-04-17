import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { getSession } from "$lib/server/sessions/registry";

/**
 * Raise a Dapr workflow external event against the session's workflow
 * instance. Delegates to the existing orchestrator proxy — no new Dapr
 * client or HTTP path. Returns the HTTP status from the orchestrator.
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
	const orchestrator = getOrchestratorUrl();
	const res = await daprFetch(
		`${orchestrator}/api/v2/workflows/${encodeURIComponent(instanceId)}/events`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ eventName, eventData }),
		},
	);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		return { ok: false, status: res.status, error: text };
	}
	return { ok: true, status: res.status };
}
