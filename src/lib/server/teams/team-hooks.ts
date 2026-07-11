/**
 * Agent Teams — task-boundary quality gates, in Claude Code's hook vocabulary.
 *
 * Claude Code exposes `TaskCreated` / `TaskCompleted` / `TeammateIdle` hooks
 * whose handlers exit 2 to BLOCK the transition and feed the reason back to
 * the agent. Codex's hooks engine adopted the same payload shapes, making them
 * the de-facto interop format — so ours match them field-for-field.
 *
 * Transport: one optional HTTP endpoint (TEAM_HOOKS_URL). For each gated
 * transition the platform POSTs `{hook_event_name, ...payload}` and reads the
 * response:
 *   • 2xx with body {"decision":"block","reason":"..."} → transition BLOCKED,
 *     reason returned to the acting agent as tool feedback;
 *   • anything else (2xx allow, non-2xx, timeout, no URL) → ALLOW.
 * Fail-open by design: a hook outage must never wedge a team (the same
 * posture as spawn's best-effort lookups).
 */

export type TeamHookEvent = "TaskCreated" | "TaskCompleted" | "TeammateIdle";

export type TeamHookResult =
	| { blocked: false }
	| { blocked: true; reason: string };

const HOOK_TIMEOUT_MS = () => {
	const raw = Number(process.env.TEAM_HOOKS_TIMEOUT_MS ?? 10_000);
	return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
};

export function teamHooksUrl(): string | null {
	const url = (process.env.TEAM_HOOKS_URL ?? "").trim();
	return url.length > 0 ? url : null;
}

/**
 * Run one team hook. `payload` should carry the Claude Code fields for the
 * event (task {id,title,description,status,assignee}, teammate {name,status},
 * team_name) — extra platform fields (teamId, sessionId) are additive.
 */
export async function runTeamHook(
	event: TeamHookEvent,
	payload: Record<string, unknown>,
): Promise<TeamHookResult> {
	const url = teamHooksUrl();
	if (!url) return { blocked: false };
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), HOOK_TIMEOUT_MS());
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hook_event_name: event, ...payload }),
			signal: controller.signal,
		}).finally(() => clearTimeout(timer));
		if (!resp.ok) {
			console.warn(`[team-hooks] ${event} hook returned HTTP ${resp.status}; allowing`);
			return { blocked: false };
		}
		const body = (await resp.json().catch(() => null)) as {
			decision?: string;
			reason?: string;
		} | null;
		if (body?.decision === "block") {
			return {
				blocked: true,
				reason:
					typeof body.reason === "string" && body.reason.trim()
						? body.reason.trim()
						: `${event} blocked by team hook`,
			};
		}
		return { blocked: false };
	} catch (err) {
		console.warn(`[team-hooks] ${event} hook failed (allowing):`, err);
		return { blocked: false };
	}
}
