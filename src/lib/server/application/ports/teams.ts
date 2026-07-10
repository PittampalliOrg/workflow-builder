/**
 * Agent Teams — persistence port.
 *
 * `TeamStore` is the boundary contract for all agent-teams persistence (teams,
 * members, the shared task list, and the team-run container execution rollup).
 * The domain modules under `$lib/server/teams` reach it through
 * `getApplicationAdapters().teamStore` so drizzle/`$lib/server/db` stay behind
 * the adapter (the `db-only-in-adapters` boundary). Rows are returned in the raw
 * snake_case shape the SQL produces — the teams domain code reads those fields
 * directly.
 */

export type TeamMemberStatus = "working" | "idle" | "failed" | "shutdown";

export type TeamMemberRow = {
	id: string;
	team_id: string;
	session_id: string;
	agent_slug: string | null;
	name: string;
	role: string;
	model: string | null;
	status: string;
	plan_mode_required: boolean;
	joined_at: string;
	updated_at: string;
};

export type TeamRow = {
	id: string;
	name: string;
	status: string;
	lead_session_id: string;
	token_budget: number | null;
};

export type TeamTaskRow = {
	id: string;
	team_id: string;
	title: string;
	description: string | null;
	status: string; // pending | in_progress | completed
	assignee_session_id: string | null;
	depends_on: string[];
	created_by_session_id: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

/** The projection `listTeamTasks` returns for the team view. */
export type TeamTaskListItem = {
	id: string;
	title: string;
	status: string;
	assignee_session_id: string | null;
	depends_on: string[];
	updated_at: string;
	completed_at: string | null;
};

export type EnsureTeamInput = {
	teamId: string;
	leadSessionId: string;
	projectId: string;
	name?: string;
	workflowExecutionId?: string | null;
};

export type AddMemberInput = {
	teamId: string;
	sessionId: string;
	name: string;
	agentSlug?: string | null;
	model?: string | null;
	planModeRequired?: boolean;
};

export type CreateTeamTaskInput = {
	teamId: string;
	title: string;
	description?: string | null;
	dependsOn?: string[];
	createdBySessionId?: string | null;
};

export interface TeamStore {
	// teams + membership
	ensureTeam(input: EnsureTeamInput): Promise<void>;
	addMember(input: AddMemberInput): Promise<TeamMemberRow>;
	listMembers(teamId: string): Promise<TeamMemberRow[]>;
	getTeam(teamId: string): Promise<TeamRow | null>;
	getMemberByName(teamId: string, name: string): Promise<TeamMemberRow | null>;
	getMemberBySession(sessionId: string): Promise<TeamMemberRow | null>;
	listIdleMembers(): Promise<TeamMemberRow[]>;
	setMemberStatus(sessionId: string, status: TeamMemberStatus): Promise<void>;
	resolveAgentIdBySlug(projectId: string, slug: string): Promise<{ id: string } | null>;

	// shared task list (atomic claim)
	listTeamTasks(teamId: string): Promise<TeamTaskListItem[]>;
	createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
	claimNextTask(input: { teamId: string; sessionId: string }): Promise<TeamTaskRow | null>;
	countClaimableTasks(teamId: string): Promise<number>;
	completeTask(input: { teamId: string; taskId: string }): Promise<TeamTaskRow | null>;

	// team-run container execution rollup
	getTeamExecutionId(teamId: string): Promise<string | null>;
	getSessionUserId(sessionId: string): Promise<string | null>;
	getSessionProjectId(sessionId: string): Promise<string | null>;
	ensureTeamRunWorkflow(projectId: string, userId: string): Promise<string>;
	setTeamExecutionId(teamId: string, executionId: string): Promise<void>;
	stampLeadSessionExecution(sessionId: string, executionId: string): Promise<void>;
	linkSessionToExecution(sessionId: string, executionId: string): Promise<void>;
	refreshTeamRunStatus(teamId: string): Promise<void>;
}
