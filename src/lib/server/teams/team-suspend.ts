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
import type {
  TeamRuntimeHostPort,
  TeamStore,
} from "$lib/server/application/ports";
import { sessionHostAppId } from "$lib/server/sessions/agent-workflow-host";
import { countClaimableTasks } from "$lib/server/teams/team-tasks";

const TEAM_SUSPEND_ENABLED = () =>
	(process.env.TEAM_SUSPEND_ENABLED ?? "false") === "true";

const TEAM_SUSPEND_IDLE_SECONDS = () => {
	const raw = Number(process.env.TEAM_SUSPEND_IDLE_SECONDS ?? 900);
	return Number.isFinite(raw) && raw >= 60 ? Math.trunc(raw) : 900;
};

const RUNTIME_OPERATION_STALE_SECONDS = 300;

const TERMINAL_SESSION_STATUSES = new Set([
  "terminated",
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "error",
  "crashed",
]);

export type TeamSuspendDeps = {
  runtimeHost: TeamRuntimeHostPort;
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
  const adapters = getApplicationAdapters();
	return {
    runtimeHost: adapters.teamRuntimeHost,
		appendSessionEvent: (sessionId, event) =>
      adapters.workflowData.appendSessionEvent(sessionId, event),
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
		let lease: Awaited<ReturnType<TeamStore["claimRuntimeOperation"]>> = null;
		let patchedSandboxName: string | null = null;
		try {
			// Claimable work pending → the nudge path owns this member (it will be
			// nudged, claim, and go working) — suspending now would just thrash.
			if ((await countClaimableTasks(c.team_id, store)) > 0) {
				skipped++;
				continue;
			}
			const sandboxName =
				c.runtime_sandbox_name ??
				`agent-host-${sessionHostAppId(c.session_id)}`;

			// Own desired-suspended before changing external state. A delivery lease
			// (or a queued unraised mailbox row) makes this claim fail atomically.
			lease = await store.claimRuntimeOperation({
				sessionId: c.session_id,
				operation: "suspend",
				staleAfterSeconds: RUNTIME_OPERATION_STALE_SECONDS,
			});
			if (!lease) {
				skipped++;
				continue;
			}
			const finish = (input: {
				memberStatus?: "suspended";
				desiredRunning?: boolean;
			} = {}) =>
				store.finishRuntimeOperation({
					sessionId: c.session_id,
					operationId: lease!.operationId,
					operation: "suspend",
					...input,
				});
			const ownsDesiredSuspended = () =>
				store.verifyRuntimeOperation({
					sessionId: c.session_id,
					operationId: lease!.operationId,
					operation: "suspend",
					desiredRunning: false,
				});

			// Work may have arrived between candidate selection and the claim. Give
			// the delivery path ownership without scaling its host down.
			if ((await countClaimableTasks(c.team_id, store)) > 0) {
				await finish({ desiredRunning: true });
				lease = null;
				skipped++;
				continue;
			}
			if (!(await ownsDesiredSuspended())) {
				await finish({ desiredRunning: true }).catch(() => false);
				lease = null;
				skipped++;
				continue;
			}

			const result = await deps.runtimeHost.suspend(sandboxName);
			if (result === "missing") {
				await finish({ desiredRunning: true });
				lease = null;
				skipped++;
				continue;
			}
			patchedSandboxName = sandboxName;

			// Recheck the exact desired-state owner after the patch. An opposite
			// delivery operation cannot steal this lease; terminal lifecycle state can
			// only make verification fail closed.
			const stillOwned = await ownsDesiredSuspended();
			if (!stillOwned) {
				await finish().catch(() => false);
				const session = await store.getSessionDeliveryState(c.session_id);
				// Resume only if the current durable intent is running. Stop/shutdown
				// owns terminal cleanup and stale suspension recovery still wants zero.
				if (
					session &&
					!session.stopRequested &&
					!TERMINAL_SESSION_STATUSES.has(session.status) &&
					session.runtimeDesiredRunning
				) {
					await deps.runtimeHost.resume(sandboxName);
				}
				lease = null;
				patchedSandboxName = null;
				skipped++;
				continue;
			}
			const finalized = await finish({ memberStatus: "suspended" });
			lease = null;
			if (!finalized) {
				const session = await store.getSessionDeliveryState(c.session_id);
				if (
					session &&
					!session.stopRequested &&
					!TERMINAL_SESSION_STATUSES.has(session.status) &&
					session.runtimeDesiredRunning
				) {
					await deps.runtimeHost.resume(sandboxName);
				}
				patchedSandboxName = null;
				skipped++;
				continue;
			}
			patchedSandboxName = null;
      await deps
        .appendSessionEvent(c.session_id, {
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
        })
        .catch((auditErr) =>
          console.warn(
            `[team-suspend] audit append failed for ${c.session_id}:`,
            auditErr instanceof Error ? auditErr.message : auditErr,
          ),
        );
			suspended++;
		} catch (err) {
			const released = lease
				? await store
						.finishRuntimeOperation({
							sessionId: c.session_id,
							operationId: lease.operationId,
							operation: "suspend",
							desiredRunning: true,
						})
						.catch(() => false)
				: false;
			lease = null;
			// A failed PATCH is ambiguous. The store changes desired state only for an
			// active session; re-read that authority before compensating so stop cannot
			// be resurrected by an in-flight suspend failure.
			if (released) {
				const session = await store
					.getSessionDeliveryState(c.session_id)
					.catch(() => null);
				if (
					session &&
					!session.stopRequested &&
					!TERMINAL_SESSION_STATUSES.has(session.status) &&
					session.runtimeDesiredRunning
				) {
					const sandboxName =
						patchedSandboxName ??
						c.runtime_sandbox_name ??
						`agent-host-${sessionHostAppId(c.session_id)}`;
					await deps.runtimeHost.resume(sandboxName).catch((resumeErr) =>
						console.error(
							`[team-suspend] failed to compensate ${c.session_id}:`,
							resumeErr instanceof Error ? resumeErr.message : resumeErr,
						),
					);
				}
			}
			skipped++;
			console.warn(
				`[team-suspend] failed to suspend ${c.session_id}:`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	return { suspended, skipped };
}
