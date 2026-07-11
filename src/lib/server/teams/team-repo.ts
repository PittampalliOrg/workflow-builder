/**
 * Agent Teams — BFF-side repo (teams / team_members).
 *
 * Thin domain facade over the `TeamStore` port: it forwards to
 * `getApplicationAdapters().teamStore` so drizzle/`$lib/server/db` stay behind
 * the adapter (the `db-only-in-adapters` boundary). Each function takes an
 * optional `store` (defaulting to the app's Postgres adapter) so the unit tests
 * can inject a PGlite-backed `PostgresTeamStore`. The task-list claim lives in
 * team-tasks.ts; this module owns team + membership rows and the name↔session
 * resolution the BFF team endpoints and the team-driver need.
 */

import { getApplicationAdapters } from "$lib/server/application";
import type {
	AddMemberInput,
	EnsureTeamInput,
	TeamMemberRow,
	TeamMemberStatus,
	TeamRow,
	TeamStore,
	TeamTaskListItem,
} from "$lib/server/application/ports";

// Re-export the row shapes so existing importers of these types keep working.
export type { TeamMemberRow, TeamRow, TeamTaskListItem } from "$lib/server/application/ports";

const store = () => getApplicationAdapters().teamStore;

/** Create the team row if missing (idempotent on the deterministic team id). */
export function ensureTeam(
	input: EnsureTeamInput,
	s: TeamStore = store(),
): Promise<void> {
	return s.ensureTeam(input);
}

export function addMember(
	input: AddMemberInput,
	s: TeamStore = store(),
): Promise<TeamMemberRow> {
	return s.addMember(input);
}

export function listMembers(
	teamId: string,
	s: TeamStore = store(),
): Promise<TeamMemberRow[]> {
	return s.listMembers(teamId);
}

export function getTeam(teamId: string, s: TeamStore = store()): Promise<TeamRow | null> {
	return s.getTeam(teamId);
}

export function listTeamTasks(
	teamId: string,
	s: TeamStore = store(),
): Promise<TeamTaskListItem[]> {
	return s.listTeamTasks(teamId);
}

/** Recent team message traffic (TeamPulse pulses + activity feed). */
export function listRecentTeamMessages(
	teamId: string,
	limit?: number,
	s: TeamStore = store(),
): ReturnType<TeamStore["listRecentTeamMessages"]> {
	return s.listRecentTeamMessages({ teamId, limit });
}

export function getMemberByName(
	teamId: string,
	name: string,
	s: TeamStore = store(),
): Promise<TeamMemberRow | null> {
	return s.getMemberByName(teamId, name);
}

/** All members currently idle (across active teams) — the tick's lost-idle set. */
export function listIdleMembers(s: TeamStore = store()): Promise<TeamMemberRow[]> {
	return s.listIdleMembers();
}

export function getMemberBySession(
	sessionId: string,
	s: TeamStore = store(),
): Promise<TeamMemberRow | null> {
	return s.getMemberBySession(sessionId);
}

export function setMemberStatus(
	sessionId: string,
	status: TeamMemberStatus,
	s: TeamStore = store(),
): Promise<void> {
	return s.setMemberStatus(sessionId, status);
}

/** Whole-team token consumption (budget gate). */
export function getTeamTokensUsed(
	teamId: string,
	s: TeamStore = store(),
): Promise<number> {
	return s.getTeamTokensUsed(teamId);
}

/** Re-point a member row at a fresh session (teammate revival). */
export function setMemberSession(
	input: { memberId: string; sessionId: string; status?: TeamMemberStatus },
	s: TeamStore = store(),
): Promise<void> {
	return s.setMemberSession(input);
}

/** OKF knowledge index for a team (frontmatter-level, no bodies). */
export function listKnowledge(
	teamId: string,
	filter?: { type?: string },
	s: TeamStore = store(),
): ReturnType<TeamStore["listKnowledge"]> {
	return s.listKnowledge(teamId, filter);
}

/** Lead approved the member's plan — drop the plan-mode gate. */
export function setMemberPlanApproved(
	sessionId: string,
	s: TeamStore = store(),
): Promise<void> {
	return s.setMemberPlanApproved(sessionId);
}

/** Resolve an agent slug to its id within a project, for peer spawn. */
export function resolveAgentIdBySlug(
	projectId: string,
	slug: string,
	s: TeamStore = store(),
): Promise<{ id: string } | null> {
	return s.resolveAgentIdBySlug(projectId, slug);
}
