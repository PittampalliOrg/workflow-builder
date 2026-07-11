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

/** Member lifecycle. Transitions each have ONE writer:
 *  working →(driver idle hook)→ idle →(suspend tick, after replicas=0)→ suspended
 *  idle|suspended →(deliver route, after a successful raise)→ working
 *  any →(shutdown route)→ shutdown (terminal). Plain text column — no migration. */
export type TeamMemberStatus =
	| "working"
	| "idle"
	| "suspended"
	| "failed"
	| "shutdown";

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
	/** Team-wide token budget (input+output across every member session). Applied
	 * only when the row is CREATED; null/absent = unlimited. */
	tokenBudget?: number | null;
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
	/** Pre-assign to a member (script-authored teams): row is created already
	 * assigned; pair with status 'in_progress' so the claim query skips it. */
	assigneeSessionId?: string | null;
	status?: "pending" | "in_progress";
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

	/** Tokens consumed by the whole team so far: sum of agent.llm_usage
	 * input+output across every member session. Feeds the token-budget gate
	 * (Codex RolloutBudget parity). */
	getTeamTokensUsed(teamId: string): Promise<number>;

	/** Re-point a member row at a fresh session (teammate revival: the old
	 * session is terminal; the member identity persists). */
	setMemberSession(input: {
		memberId: string;
		sessionId: string;
		status?: TeamMemberStatus;
	}): Promise<void>;

	/** Flip plan_mode_required off once the lead approves the member's plan. */
	setMemberPlanApproved(sessionId: string): Promise<void>;

	// shared task list (atomic claim)
	listTeamTasks(teamId: string): Promise<TeamTaskListItem[]>;
	createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
	claimNextTask(input: { teamId: string; sessionId: string }): Promise<TeamTaskRow | null>;
	countClaimableTasks(teamId: string): Promise<number>;
	completeTask(input: { teamId: string; taskId: string }): Promise<TeamTaskRow | null>;

	/** One-query snapshot for the wake-on-deliver decision (team-delivery.ts). */
	getSessionDeliveryState(sessionId: string): Promise<{
		status: string;
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
	} | null>;

	/** Teammates idle past the silence threshold — the suspend tick's candidates. */
	listSuspendCandidates(input: { idleSeconds: number }): Promise<
		Array<{
			team_id: string;
			session_id: string;
			name: string;
			runtime_sandbox_name: string | null;
			last_event_at: string | null;
			updated_at: string;
			idle_seconds: number;
		}>
	>;

	/** Member sessions holding unraised team-origin messages older than the
	 * threshold — the delivery sweeper's re-publish set (lost-delivery healing). */
	listSessionsWithStrandedTeamMessages(input: {
		olderThanSeconds: number;
	}): Promise<Array<{ session_id: string; stranded: number }>>;

	/** The team's recent message traffic (team-origin user.messages across all
	 * member inboxes, incl. the lead), newest first — feeds the TeamPulse
	 * topology's message pulses + unified activity timeline. */
	listRecentTeamMessages(input: { teamId: string; limit?: number }): Promise<
		Array<{
			ts: string;
			from_name: string | null;
			to_session_id: string;
			to_name: string | null;
			kind: string;
			preview: string | null;
		}>
	>;

	// ── script-authored teams ("the script is the lead") ─────────────────────

	/** Owner context of an execution — the script team's user/project scope. */
	getExecutionContext(
		executionId: string,
	): Promise<{ userId: string; projectId: string | null } | null>;

	/** Idempotently create the script team's lead ANCHOR session (plus the
	 * synthetic archived `script-team-lead` agent the sessions.agent_id FK
	 * requires). The anchor is a plain row — no runtime — that mailbox appends
	 * and project scoping resolve against; workflow_execution_id ties it (and
	 * therefore the team) to the script's run. */
	ensureScriptLeadSession(input: {
		sessionId: string;
		userId: string;
		projectId: string | null;
		executionId: string;
		title?: string;
	}): Promise<void>;

	/** The execution a session already belongs to (team-run adoption). */
	getSessionExecutionId(sessionId: string): Promise<string | null>;

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
