/**
 * Agent Teams — suspend-on-idle (native agent-sandbox scale-to-zero).
 *
 * Idle teammates hold their full runtime pod for the host-monitor's 6h
 * abandoned-idle window doing nothing. This tick suspends them much sooner:
 * for every team member idle past TEAM_SUSPEND_IDLE_SECONDS with no claimable
 * work, patch the session's Sandbox CR to spec.replicas=0 — the controller
 * deletes the pod (releasing its Kueue quota) while the CR, its podTemplate,
 * and the parked session_workflow in the task hub all survive. Any later
 * message/nudge wakes it through team-delivery.ts (replicas 0→1 + raise).
 *
 * The patch is idempotent and also CONVERGES the stale case where the
 * host-monitor already exited (pod dead/exited but replicas still 1).
 * `suspended` member status is written only AFTER a successful patch; cluster
 * truth is always re-probed by the deliver path, so a stale status can never
 * strand a message.
 *
 * Runs inside runTeamDriverTick (the Dapr cron binding, every 60s). Gated on
 * TEAM_SUSPEND_ENABLED (default off) for staged rollout.
 */

import { getApplicationAdapters } from "$lib/server/application";
import type { TeamStore } from "$lib/server/application/ports";
import { suspendSessionSandbox } from "$lib/server/kube/client";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";
import { setMemberStatus } from "$lib/server/teams/team-repo";
import { countClaimableTasks } from "$lib/server/teams/team-tasks";

const TEAM_SUSPEND_ENABLED = () =>
	(process.env.TEAM_SUSPEND_ENABLED ?? "false") === "true";

const TEAM_SUSPEND_IDLE_SECONDS = () => {
	const raw = Number(process.env.TEAM_SUSPEND_IDLE_SECONDS ?? 900);
	return Number.isFinite(raw) && raw >= 60 ? Math.trunc(raw) : 900;
};

export type TeamSuspendDeps = {
	suspendSessionSandbox: typeof suspendSessionSandbox;
	appendSessionEvent: (
		sessionId: string,
		event: {
			type: string;
			data?: Record<string, unknown>;
			processedAt?: Date | null;
			sourceEventId?: string | null;
		},
	) => Promise<unknown>;
};

function realDeps(): TeamSuspendDeps {
	return {
		suspendSessionSandbox,
		appendSessionEvent: (sessionId, event) =>
			getApplicationAdapters().workflowData.appendSessionEvent(sessionId, event),
	};
}

/**
 * One suspend pass. Returns counts for the tick's log line. Safe to run from
 * the unauthenticated cron tick: every action is server-derived (only members
 * that genuinely are idle past the threshold), idempotent, and reversible
 * (any message wakes the member).
 */
export async function runTeamSuspendTick(
	storeArg?: TeamStore,
	depsArg?: TeamSuspendDeps,
): Promise<{ suspended: number; skipped: number }> {
	// Gate BEFORE resolving defaults so a disabled tick never touches the
	// application container (keeps unit tests of callers hermetic too).
	if (!TEAM_SUSPEND_ENABLED()) return { suspended: 0, skipped: 0 };
	const store = storeArg ?? getApplicationAdapters().teamStore;
	const deps = depsArg ?? realDeps();
	const candidates = await store.listSuspendCandidates({
		idleSeconds: TEAM_SUSPEND_IDLE_SECONDS(),
	});
	let suspended = 0;
	let skipped = 0;
	for (const c of candidates) {
		try {
			// Claimable work pending → the nudge path owns this member (it will be
			// nudged, claim, and go working) — suspending now would just thrash.
			if ((await countClaimableTasks(c.team_id, store)) > 0) {
				skipped++;
				continue;
			}
			const sandboxName =
				c.runtime_sandbox_name ?? `agent-host-${sessionHostAppId(c.session_id)}`;
			const result = await deps.suspendSessionSandbox(sandboxName);
			if (result === "missing") {
				// CR gone (session destroyed under us) — leave status alone; the
				// liveness reconciler owns terminal convergence.
				skipped++;
				continue;
			}
			await setMemberStatus(c.session_id, "suspended", store);
			await deps.appendSessionEvent(c.session_id, {
				type: "session.host_suspended",
				data: {
					source: "team-suspend-tick",
					sandboxName,
					idleSeconds: c.idle_seconds,
				},
				// Control/audit event — processedAt set so it can never be claimed
				// as a deliverable message.
				processedAt: new Date(),
				sourceEventId: `host-suspend:${c.session_id}:${c.last_event_at ?? c.updated_at}`,
			});
			suspended++;
		} catch (err) {
			skipped++;
			console.warn(
				`[team-suspend] failed to suspend ${c.session_id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	return { suspended, skipped };
}
