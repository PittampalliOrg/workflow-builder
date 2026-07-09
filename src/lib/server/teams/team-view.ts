/**
 * Team view assembly — the shape the session-detail team panel renders.
 * Shared by the public (authed) and internal (token) GET endpoints.
 */

import {
	getMemberBySession,
	getTeam,
	listMembers,
	listTeamTasks,
} from "$lib/server/teams/team-repo";

export type TeamView = {
	team: { id: string; name: string; status: string; tokenBudget: number | null };
	members: Array<{ name: string; role: string; status: string; sessionId: string }>;
	tasks: Array<{ id: string; title: string; status: string; assignee: string | null }>;
} | null;

/** Assemble the team view for a team id (null if the team doesn't exist). */
export async function getTeamView(teamId: string): Promise<TeamView> {
	const team = await getTeam(teamId);
	if (!team) return null;
	const [members, tasks] = await Promise.all([
		listMembers(teamId),
		listTeamTasks(teamId),
	]);
	return {
		team: { id: team.id, name: team.name, status: team.status, tokenBudget: team.token_budget },
		members: members.map((m) => ({
			name: m.name,
			role: m.role,
			status: m.status,
			sessionId: m.session_id,
		})),
		tasks: tasks.map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			assignee: t.assignee_session_id,
		})),
	};
}

/** Resolve the team a session belongs to (as lead or member), then its view. */
export async function getTeamViewForSession(sessionId: string): Promise<TeamView> {
	const member = await getMemberBySession(sessionId);
	if (!member) return null;
	return getTeamView(member.team_id);
}
