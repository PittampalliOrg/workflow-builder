/**
 * Server-side RPC to a per-session agent runtime (session_workflow) for the
 * orchestrator's FIRE-AND-POLL durable/run dispatch.
 *
 * Per-session Kueue sandboxes get only a headless service (no Dapr `-dapr`
 * service), so they are NOT reachable via Dapr service-invoke from the
 * orchestrator. The BFF, however, discovers the sandbox's pod URL via
 * `waitForAgentWorkflowHostAppReady` (the same path direct-session spawn uses),
 * so the orchestrator routes start/poll/terminate through these BFF endpoints
 * instead of calling the sandbox directly. See
 * docs/workflow-lifecycle-termination.md + [[project_workflow_run_stop_crossapp_child_wedge]].
 */
import { daprFetch } from "$lib/server/dapr-client";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";

const TERMINAL_RUNTIME_STATUSES = new Set(["COMPLETED", "FAILED", "TERMINATED"]);

async function resolveBaseUrl(agentAppId: string): Promise<string | null> {
	try {
		const ready = await waitForAgentWorkflowHostAppReady({ agentAppId });
		return ready?.baseUrl ?? null;
	} catch {
		// Sandbox not ready / not resolvable yet — caller treats as "not ready".
		return null;
	}
}

/** Fire-and-forget start of session_workflow on the per-session sandbox.
 * Idempotent (the sandbox's /internal/sessions/spawn reuses an existing id). */
export async function startAgentRuntimeSession(p: {
	agentAppId: string;
	instanceId: string;
	payload: unknown;
}): Promise<{ ok: boolean; notReady: boolean; status?: number; error?: string }> {
	const baseUrl = await resolveBaseUrl(p.agentAppId);
	if (!baseUrl) return { ok: false, notReady: true };
	try {
		const res = await daprFetch(`${baseUrl}/internal/sessions/spawn`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instanceId: p.instanceId, payload: p.payload ?? {} }),
			maxRetries: 0,
		});
		if (res.ok || res.status === 409) return { ok: true, notReady: false };
		return {
			ok: false,
			notReady: res.status >= 500,
			status: res.status,
			error: (await res.text().catch(() => "")).slice(0, 300),
		};
	} catch (e) {
		return { ok: false, notReady: true, error: String(e).slice(0, 300) };
	}
}

/** Poll session_workflow's runtime status + serialized output. Never throws. */
export async function pollAgentRuntimeStatus(p: {
	agentAppId: string;
	instanceId: string;
}): Promise<{
	complete: boolean;
	runtimeStatus: string;
	output?: unknown;
	missing?: boolean;
	error?: string;
}> {
	const baseUrl = await resolveBaseUrl(p.agentAppId);
	if (!baseUrl) return { complete: false, runtimeStatus: "UNKNOWN" };
	try {
		const res = await daprFetch(
			`${baseUrl}/api/v2/agent-runs/${encodeURIComponent(p.instanceId)}/status`,
			{ method: "GET", maxRetries: 0 },
		);
		if (res.status === 404) {
			return { complete: true, runtimeStatus: "GONE", missing: true, output: null };
		}
		if (!res.ok) {
			return {
				complete: false,
				runtimeStatus: "UNKNOWN",
				error: (await res.text().catch(() => "")).slice(0, 300),
			};
		}
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		const rs = String(body.runtimeStatus ?? "").toUpperCase();
		return {
			complete: TERMINAL_RUNTIME_STATUSES.has(rs),
			runtimeStatus: rs,
			output: body.output ?? null,
			missing: false,
		};
	} catch (e) {
		return { complete: false, runtimeStatus: "UNKNOWN", error: String(e).slice(0, 300) };
	}
}

/** Terminate session_workflow on the per-session sandbox (cancel / timeout).
 * Best-effort — unreachable / 404 counts as already-gone. */
export async function terminateAgentRuntimeSession(p: {
	agentAppId: string;
	instanceId: string;
	reason?: string;
}): Promise<{ ok: boolean; status?: number; missing?: boolean; error?: string }> {
	const baseUrl = await resolveBaseUrl(p.agentAppId);
	if (!baseUrl) return { ok: true, missing: true };
	try {
		const res = await daprFetch(
			`${baseUrl}/api/v2/agent-runs/${encodeURIComponent(p.instanceId)}/terminate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason: p.reason ?? "workflow cancelled" }),
				maxRetries: 0,
			},
		);
		return { ok: res.ok || res.status === 404, status: res.status };
	} catch (e) {
		return { ok: false, error: String(e).slice(0, 300) };
	}
}
