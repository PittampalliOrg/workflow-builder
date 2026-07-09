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

import { db as defaultDb } from "$lib/server/db";
import {
	getMemberBySession,
	listIdleMembers,
	listMembers,
	setMemberStatus,
	type TeamsDb,
} from "$lib/server/teams/team-repo";
import { injectTeamMessage } from "$lib/server/teams/team-messaging";
import { countClaimableTasks } from "$lib/server/teams/team-tasks";

const AUTO_CLAIM = (process.env.TEAM_AUTO_CLAIM ?? "true") !== "false";

/**
 * React to a session event for a session that belongs to a team. No-op (and
 * cheap) for non-team sessions: the first getMemberBySession lookup returns null.
 */
export async function onTeamSessionEvent(
	sessionId: string,
	event: { type: string; data?: Record<string, unknown> },
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<void> {
	try {
		if (event.type !== "session.status_idle") return;
		const member = await getMemberBySession(sessionId, db);
		if (!member || member.role === "lead") return; // only teammates notify the lead

		// Any idle means the teammate finished its turn and is now available/done —
		// notify the lead regardless of the specific stop reason (end_turn,
		// goal_stop, etc.). Unlike the goal loop (which only *continues* on
		// end_turn), a team idle notice is informational.
		const reason = (event.data?.stop_reason as { type?: string } | undefined)?.type;

		await setMemberStatus(sessionId, "idle", db);

		// Notify the lead. Deterministic id keyed on the member + a coarse idle
		// marker so repeated idles within the same turn dedupe. We include the
		// updated_at to distinguish successive genuine idles.
		const members = await listMembers(member.team_id, db);
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

		// Auto-claim: offer the idle teammate its next unblocked task by nudging it
		// to call claim_task — but ONLY when there is actually claimable work.
		// Nudging on every idle regardless of work causes an idle→nudge→idle loop
		// (the teammate wakes, finds nothing, idles, gets nudged again...). Gating
		// on claimable count breaks that loop; the claim itself stays agent-driven
		// + atomic, so exactly-once remains owned by the SQL claim.
		if (AUTO_CLAIM && (await countClaimableTasks(db, member.team_id)) > 0) {
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
 */
export async function runTeamDriverTick(
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<{ nudged: number }> {
	const idle = await listIdleMembers(db);
	let nudged = 0;
	for (const m of idle) {
		if (m.role === "lead") continue;
		// Only nudge when the member's team actually has claimable work — same
		// loop-guard as the reactive path.
		if ((await countClaimableTasks(db, m.team_id)) === 0) continue;
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
	return { nudged };
}
