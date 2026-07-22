/**
 * Agent Teams — reactive coordinator (out-of-band, mirrors goal-loop).
 *
 * Wired into session-events post-append hooks. NOT a workflow body and NOT a
 * long-running loop: it reacts to individual session events and returns. A Dapr
 * Job (team-driver-tick) provides the lost-idle backstop (see stacks Job manifest).
 *
 * Reactions:
 *   • teammate `session.status_idle(end_turn)` → mark the member idle and inject
 *     an idle-notice into the LEAD (deterministic sourceEventId). If the team is
 *     in auto-claim mode, atomically hand the teammate its next unblocked task.
 *   • `task.completed` semantics are carried by the claim query re-checking deps,
 *     so no explicit unblock write is needed; we just nudge idle teammates.
 *
 * Every injected message carries a deterministic sourceEventId so Dapr replay and
 * dual ingest dedupe (the same invariant the goal loop relies on).
 */

import { getApplicationAdapters } from "$lib/server/application";
import type { TeamStore } from "$lib/server/application/ports";
import {
	getMemberBySession,
	listIdleMembers,
	listMembers,
	listTeamTasks,
  transitionActiveMemberStatus,
  transitionMemberToFailed,
} from "$lib/server/teams/team-repo";
import {
  injectTeamMessage,
  TEAM_MESSAGE_TOPIC,
} from "$lib/server/teams/team-messaging";
import { runTeamSuspendTick } from "$lib/server/teams/team-suspend";
import { countClaimableTasks } from "$lib/server/teams/team-tasks";
import { refreshTeamRunStatus } from "$lib/server/teams/team-run";
import { getTeamBudget } from "$lib/server/teams/team-budget";
import { runTeamHook } from "$lib/server/teams/team-hooks";

const AUTO_CLAIM = (process.env.TEAM_AUTO_CLAIM ?? "true") !== "false";

/**
 * Tasks this member CLAIMED but never completed. An idle member holding an
 * in_progress task is the stall mode neither nudge above covers: the task is
 * not claimable (someone holds it) so the claim nudge never fires, and the
 * holder thinks it's done — the team deadlocks until the join times out.
 * Observed on dev 2026-07-11: the role-agnostic claim queue handed the
 * "writer's" task to the researcher, which decided it wasn't its job and
 * idled while holding it.
 */
async function listHeldTasks(
	teamId: string,
	sessionId: string,
	store: TeamStore,
): Promise<Array<{ id: string; title: string; updated_at: string }>> {
	const tasks = await listTeamTasks(teamId, store);
	return tasks
    .filter(
      (t) => t.status === "in_progress" && t.assignee_session_id === sessionId,
    )
		.map((t) => ({ id: t.id, title: t.title, updated_at: t.updated_at }));
}

function heldTaskNudge(task: { id: string; title: string }): string {
	return (
		`You still hold task ${task.id} ("${task.title}") — it is in_progress and assigned to YOU. ` +
		"A claimed task is yours regardless of your role name. Do the work now and call " +
		`update_task("${task.id}", "completed") with the deliverable; if you genuinely cannot, ` +
		"send_message the lead explaining why — but do not go idle while holding it."
	);
}

/**
 * React to a session event for a session that belongs to a team. No-op (and
 * cheap) for non-team sessions: the first getMemberBySession lookup returns null.
 */
export async function onTeamSessionEvent(
	sessionId: string,
	event: { type: string; data?: Record<string, unknown> },
	store: TeamStore = getApplicationAdapters().teamStore,
): Promise<void> {
	try {
    if (event.type !== "session.status_idle" && event.type !== "session.error")
      return;
		const member = await getMemberBySession(sessionId, store);
		if (!member || member.role === "lead") return; // only teammates notify the lead
		// `shutdown` is TERMINAL: a stopping teammate's final turn still emits one
		// last status_idle, which used to overwrite the shutdown marker back to
		// idle (observed on the first team-script E2E). Never resurrect it.
		if (member.status === "shutdown") return;

		// Failure ≠ idle: an errored teammate must not look like a finished one
		// (CC v2.1.198 parity). Mark it failed and give the lead the error text —
		// "failed" is quiescent for join/wait predicates, so the run still drains.
		if (event.type === "session.error") {
			const errorText = String(event.data?.error ?? "").slice(0, 300);
      if (!(await transitionMemberToFailed(sessionId, store))) return;
			await refreshTeamRunStatus(member.team_id, store);
			const errMembers = await listMembers(member.team_id, store);
			const errLead = errMembers.find((m) => m.role === "lead");
			if (errLead) {
				await injectTeamMessage({
					recipientSessionId: errLead.session_id,
					fromName: member.name,
					content: `Teammate "${member.name}" FAILED${errorText ? `: ${errorText}` : " (no error detail)"}. It is no longer working; revive_teammate can respawn it from its transcript.`,
					kind: "team-error",
					sourceEventId: `team-error:${sessionId}:${member.updated_at}`,
				});
			}
			return;
		}

		// Any idle means the teammate finished its turn and is now available/done —
		// notify the lead regardless of the specific stop reason (end_turn,
		// goal_stop, etc.). Unlike the goal loop (which only *continues* on
		// end_turn), a team idle notice is informational.
    const reason = (event.data?.stop_reason as { type?: string } | undefined)
      ?.type;

    if (
      !(await transitionActiveMemberStatus(
        {
          sessionId,
          expectedStatuses: ["working", "idle"],
          status: "idle",
        },
        store,
      ))
    ) {
      return;
    }

		// Recompute the container run's status from team state so the Fleet/runs
		// list reflects the team live (no-op for teams without an execution row).
		await refreshTeamRunStatus(member.team_id, store);

		// TeammateIdle quality gate (Claude Code hook parity): a configured hook
		// can BLOCK the idle and send the teammate back to work with feedback —
		// the platform analog of exit-code-2. Fail-open (no hook/timeout = allow).
		const idleGate = await runTeamHook("TeammateIdle", {
			team_name: member.team_id,
			teamId: member.team_id,
			teammate: { name: member.name, status: "idle" },
			sessionId,
		});
		if (idleGate.blocked) {
			await injectTeamMessage({
				recipientSessionId: sessionId,
				fromName: "team",
				content: `Your idle was rejected by a team quality gate: ${idleGate.reason}\nAddress the feedback, then finish properly.`,
				kind: "team-idle",
				sourceEventId: `team-hook-idle:${sessionId}:${member.updated_at}`,
			});
			return;
		}

		// Notify the lead. Deterministic id keyed on the member + a coarse idle
		// marker so repeated idles within the same turn dedupe. We include the
		// updated_at to distinguish successive genuine idles.
		const members = await listMembers(member.team_id, store);
		const lead = members.find((m) => m.role === "lead");
		if (lead) {
			await injectTeamMessage({
				recipientSessionId: lead.session_id,
				fromName: member.name,
				content: `Teammate "${member.name}" is idle${reason ? ` (${reason})` : ""}.`,
				kind: "team-idle",
				sourceEventId: `team-idle:${sessionId}:${member.updated_at}`,
			});
		}

		// Held-task check FIRST: an idle member still holding an in_progress task
		// must finish (or escalate) it before anything else — that task is
		// invisible to the claim nudge (not claimable) and blocks the join.
		// sourceEventId keys on the TASK's updated_at (stable while held), so a
		// stubborn holder is nudged at most once per hold — no idle→nudge loop.
    const held = AUTO_CLAIM
      ? await listHeldTasks(member.team_id, sessionId, store)
      : [];
		if (held.length > 0) {
			await injectTeamMessage({
				recipientSessionId: sessionId,
				fromName: "team",
				content: heldTaskNudge(held[0]),
				kind: "team-idle",
				sourceEventId: `team-hold-nudge:${sessionId}:${held[0].id}:${held[0].updated_at}`,
			});
			return;
		}

		// Token-budget brake: an exhausted team gets no NEW work fed to it (the
		// hold nudge above still runs — finishing held work is always right).
		// In-flight turns are untouched; the budget is a brake, not a kill switch.
		const budget = await getTeamBudget(member.team_id, store).catch(() => null);
		if (budget?.exhausted) return;

		// Auto-claim: offer the idle teammate its next unblocked task by nudging it
		// to call claim_task — but ONLY when there is actually claimable work.
		// Nudging on every idle regardless of work causes an idle→nudge→idle loop
		// (the teammate wakes, finds nothing, idles, gets nudged again...). Gating
		// on claimable count breaks that loop; the claim itself stays agent-driven
		// + atomic, so exactly-once remains owned by the SQL claim.
		if (AUTO_CLAIM && (await countClaimableTasks(member.team_id, store)) > 0) {
			await injectTeamMessage({
				recipientSessionId: sessionId,
				fromName: "team",
				content:
					"You are idle and there is unclaimed work. Call claim_task to take the next unblocked task.",
				kind: "team-idle",
				sourceEventId: `team-claim-nudge:${sessionId}:${member.updated_at}`,
			});
		}
	} catch (err) {
		console.warn("[team-driver] event hook failed:", err);
	}
}

/**
 * Lost-idle backstop, invoked by the Dapr cron binding (team-driver-tick). If a
 * teammate went idle but its idle event never reached the reactive hook (BFF
 * outage, dropped event), re-nudge it to claim. The deterministic sourceEventId
 * (keyed on the member's updated_at) means a stable idle state is nudged at most
 * once, so repeated ticks don't spam — the same exactly-once discipline the goal
 * loop's tick reaper uses.
 *
 * Nudge candidates include SUSPENDED members: the nudge routes through the
 * team-message topic (injectTeamMessage → team-delivery), which wakes the
 * suspended sandbox — so "claimable work appeared" wakes the teammate for free.
 * After the nudge pass, the suspend tick scales genuinely idle teammates'
 * sandboxes to zero (team-suspend.ts; gated on TEAM_SUSPEND_ENABLED).
 */
export async function runTeamDriverTick(
	store: TeamStore = getApplicationAdapters().teamStore,
): Promise<{ nudged: number; suspended: number; swept: number }> {
	const idle = await listIdleMembers(store);
	let nudged = 0;
	for (const m of idle) {
		if (m.role === "lead") continue;
		// Held-task backstop first — same reasoning + dedupe key as the reactive
		// path, so a hold that already got the reactive nudge is not re-nudged.
		const held = await listHeldTasks(m.team_id, m.session_id, store);
		if (held.length > 0) {
			await injectTeamMessage({
				recipientSessionId: m.session_id,
				fromName: "team",
				content: heldTaskNudge(held[0]),
				kind: "team-idle",
				sourceEventId: `team-hold-nudge:${m.session_id}:${held[0].id}:${held[0].updated_at}`,
			});
			nudged++;
			continue;
		}
		// Only nudge when the member's team actually has claimable work — same
		// loop-guard as the reactive path — and never feed an exhausted budget.
		if ((await countClaimableTasks(m.team_id, store)) === 0) continue;
		const budget = await getTeamBudget(m.team_id, store).catch(() => null);
		if (budget?.exhausted) continue;
		await injectTeamMessage({
			recipientSessionId: m.session_id,
			fromName: "team",
			content:
				"Lost-idle check: call claim_task to take the next unblocked task.",
			kind: "team-idle",
			sourceEventId: `team-tick:${m.session_id}:${m.updated_at}`,
		});
		nudged++;
	}
	// Delivery sweeper: re-publish a trigger for any runtime-backed team session holding
	// unraised team-origin messages older than the threshold. Heals lost pubsub
	// deliveries (observed once on dev: JetStream acked with no route effect and
	// zero redelivery). Duplicate triggers are harmless — the atomic claim in
	// team-delivery collapses them; a session with a live in-flight delivery
	// just resolves to an empty claim.
	let swept = 0;
	try {
		const stranded = await store.listSessionsWithStrandedTeamMessages({
			olderThanSeconds: Number(process.env.TEAM_DELIVERY_SWEEP_SECONDS ?? 120),
		});
		for (const s of stranded) {
			await getApplicationAdapters().eventBus.publish(TEAM_MESSAGE_TOPIC, {
				recipientSessionId: s.session_id,
				sourceEventId: `team-sweep:${s.session_id}`,
				kind: "team-idle",
			});
			console.info(
				`[team-driver] swept ${s.stranded} stranded message(s) for ${s.session_id}`,
			);
			swept++;
		}
	} catch (err) {
		console.warn("[team-driver] delivery sweep failed:", err);
	}
	const suspend = await runTeamSuspendTick(store).catch((err) => {
		console.warn("[team-driver] suspend tick failed:", err);
		return { suspended: 0, skipped: 0 };
	});
	return { nudged, suspended: suspend.suspended, swept };
}
