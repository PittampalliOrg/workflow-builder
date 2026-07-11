/**
 * Team view assembly — the shape the session-detail team panel and the team-run
 * panel render. Shared by the public (authed) and internal (token) GET endpoints.
 *
 * Beyond the raw member/task rows this resolves the linkage the UI needs to read
 * like a dynamic-script run: each member's *current* task, each task's assignee
 * *name* (not just session id), and a chronological *activity feed* (claims +
 * completions) synthesized from the task rows. That linkage is what lets the
 * team-run panel show task↔member↔transcript in one pane.
 */

import {
	getMemberBySession,
	getTeam,
	getTeamTokensUsed,
	listMembers,
	listRecentTeamMessages,
	listTeamTasks,
} from "$lib/server/teams/team-repo";
import type { TeamStore } from "$lib/server/application/ports";

export type TeamActivityEvent = {
	/** ISO-ish timestamp string from Postgres (claim = updated_at, done = completed_at). */
	ts: string;
	kind: "claimed" | "completed";
	taskId: string;
	taskTitle: string;
	memberName: string | null;
};

export type TeamMessageEvent = {
	ts: string;
	/** Sender name (data.fromAgent) — 'lead'/'team' or a member name. */
	from: string | null;
	/** Recipient member name (resolved from the recipient session). */
	to: string | null;
	toSessionId: string;
	kind: string; // teammate-message | team-broadcast | team-idle
	preview: string | null;
};

export type TeamView = {
	team: {
		id: string;
		name: string;
		status: string;
		tokenBudget: number | null;
		/** input+output tokens consumed across all member sessions — only
		 * computed (non-zero) when a budget is set, to keep the poll cheap. */
		tokensUsed: number;
	};
	members: Array<{
		name: string;
		role: string;
		status: string;
		sessionId: string;
		/** id of the task this member is currently working (in_progress + assigned), else null. */
		currentTaskId: string | null;
	}>;
	tasks: Array<{
		id: string;
		title: string;
		status: string;
		assignee: string | null;
		assigneeName: string | null;
		dependsOn: string[];
	}>;
	/** Coordination timeline, most-recent first: who claimed/completed what, when. */
	activity: TeamActivityEvent[];
	/** Recent message traffic, newest first (TeamPulse pulses + feed). */
	recentMessages: TeamMessageEvent[];
} | null;

/** Assemble the team view for a team id (null if the team doesn't exist). */
export async function getTeamView(
	teamId: string,
	s?: TeamStore,
): Promise<TeamView> {
	const team = await getTeam(teamId, s);
	if (!team) return null;
	const [members, tasks, messages, tokensUsed] = await Promise.all([
		listMembers(teamId, s),
		listTeamTasks(teamId, s),
		listRecentTeamMessages(teamId, 30, s),
		// Budget consumption only matters when a budget exists — skip the
		// session_events aggregate otherwise (this view polls every ~3s).
		team.token_budget != null ? getTeamTokensUsed(teamId, s) : Promise.resolve(0),
	]);

	const nameBySession = new Map(members.map((m) => [m.session_id, m.name]));

	// Which task each member is actively working (in_progress + assigned to them).
	const currentTaskBySession = new Map<string, string>();
	for (const t of tasks) {
		if (t.status === "in_progress" && t.assignee_session_id) {
			currentTaskBySession.set(t.assignee_session_id, t.id);
		}
	}

	// Activity feed from task lifecycle: a completed task contributes a "completed"
	// event (completed_at); a still-running claimed task contributes a "claimed"
	// event (updated_at). We only have one mutable timestamp per row, so a completed
	// task shows its terminal event rather than a stale claim. Most-recent first.
	const activity: TeamActivityEvent[] = [];
	for (const t of tasks) {
		const memberName = t.assignee_session_id
			? nameBySession.get(t.assignee_session_id) ?? null
			: null;
		if (t.status === "completed") {
			activity.push({
				ts: t.completed_at ?? t.updated_at,
				kind: "completed",
				taskId: t.id,
				taskTitle: t.title,
				memberName,
			});
		} else if (t.status === "in_progress" && t.assignee_session_id) {
			activity.push({
				ts: t.updated_at,
				kind: "claimed",
				taskId: t.id,
				taskTitle: t.title,
				memberName,
			});
		}
	}
	activity.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

	return {
		team: {
			id: team.id,
			name: team.name,
			status: team.status,
			tokenBudget: team.token_budget,
			tokensUsed,
		},
		members: members.map((m) => ({
			name: m.name,
			role: m.role,
			status: m.status,
			sessionId: m.session_id,
			currentTaskId: currentTaskBySession.get(m.session_id) ?? null,
		})),
		tasks: tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			assignee: t.assignee_session_id,
			assigneeName: t.assignee_session_id
				? nameBySession.get(t.assignee_session_id) ?? null
				: null,
			dependsOn: t.depends_on ?? [],
		})),
		activity,
		recentMessages: messages.map((m) => ({
			ts: m.ts,
			from: m.from_name,
			to: m.to_name,
			toSessionId: m.to_session_id,
			kind: m.kind,
			preview: m.preview,
		})),
	};
}

/** Resolve the team a session belongs to (as lead or member), then its view. */
export async function getTeamViewForSession(
	sessionId: string,
	s?: TeamStore,
): Promise<TeamView> {
	const member = await getMemberBySession(sessionId, s);
	if (!member) return null;
	return getTeamView(member.team_id, s);
}
