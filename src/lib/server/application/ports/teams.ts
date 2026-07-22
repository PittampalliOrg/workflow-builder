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
 *  starting →(team member launch, after child dispatch is fenced)→ working
 *  working →(driver idle hook)→ idle →(suspend tick, after replicas=0)→ suspended
 *  idle|suspended →(deliver route, after a successful raise)→ working
 *  any →(shutdown route)→ shutdown (terminal). Plain text column — no migration. */
export type TeamMemberStatus =
  | "starting"
	| "working"
	| "idle"
	| "suspended"
	| "failed"
	| "shutdown";

export type ActiveTeamMemberStatus = Exclude<
  TeamMemberStatus,
  "starting" | "failed" | "shutdown"
>;

export type TerminalTeamMemberStatus = Extract<
  TeamMemberStatus,
  "failed" | "shutdown"
>;

export type TeamMemberShutdownFinalizeResult =
  | "updated"
  | "already_terminal"
  | "stale";

export type TeamRuntimePodStatus = {
  presence: "present" | "absent" | "unknown";
  exited: boolean;
};

export type TeamRuntimeSandboxState =
  | { presence: "present"; desiredRunning: boolean }
  | { presence: "absent" };

export type TeamRuntimeOperation = "delivery" | "suspend";

/**
 * Exact ownership token for a teammate runtime desired-state transition.
 *
 * The store is the authority for mutual exclusion. Kubernetes remains an
 * adapter-side effect performed only while this lease is current.
 */
export type TeamRuntimeOperationLease = {
  operationId: string;
  operation: TeamRuntimeOperation;
  desiredRunning: boolean;
  startedAt: string;
  memberStatus: string;
  daprInstanceId: string;
  runtimeAppId: string | null;
  runtimeSandboxName: string | null;
};

/** Infrastructure boundary for the per-session runtime host used by teammates. */
export interface TeamRuntimeHostPort {
  getPodStatus(input: { runtimeAppId: string }): Promise<TeamRuntimePodStatus>;
  getSandboxState(sandboxName: string): Promise<TeamRuntimeSandboxState>;
  deleteExitedPods(input: { runtimeAppId: string }): Promise<string[]>;
  suspend(sandboxName: string): Promise<"patched" | "missing">;
  resume(sandboxName: string): Promise<"patched" | "missing">;
  waitUntilReady(input: {
    runtimeAppId: string;
    timeoutSeconds: number;
  }): Promise<void>;
}

export type TeamMailboxRuntimeEligibility =
  | { status: "eligible"; runtimeId: string; agentVersion: number }
  | {
      status: "ineligible";
      reason:
        | "agent_not_found"
        | "agent_version_mismatch"
        | "session_not_found"
        | "runtime_unsupported";
      runtimeId: string | null;
      agentVersion: number | null;
    };

/**
 * Driven boundary for resolving saved agents and sessions against the runtime
 * registry's durable team-mailbox receipt contract.
 */
export interface TeamMailboxRuntimeEligibilityPort {
  evaluateAgent(input: {
    agentId: string;
    agentVersion?: number | null;
  }): Promise<TeamMailboxRuntimeEligibility>;
  evaluateSession(input: {
    sessionId: string;
  }): Promise<TeamMailboxRuntimeEligibility>;
}

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
  /** Exact durable launch operation retained until the next launch attempt. */
  launch_operation_id?: string | null;
  launch_kind?: TeamMemberLaunchKind | null;
  launch_started_at?: string | null;
  launch_completed_at?: string | null;
  launch_cleanup_requested_at?: string | null;
  launch_cleanup_action?: TeamMemberLaunchCleanupAction | null;
  launch_previous_session_id?: string | null;
  launch_previous_status?: TerminalTeamMemberStatus | null;
  launch_dispatch_recipe?: TeamMemberPeerDispatchRecipe | null;
};

export type TeamMemberLaunchKind = "spawn" | "revival";
export type TeamMemberLaunchCleanupAction = "purge" | "unwind";

export type TeamMemberPeerDispatchRecipe = {
  version: 1;
  teamId: string;
  principal: {
    userId: string;
    projectId: string;
    sessionId: string;
    capabilities: {
      scriptDepth: number;
      teamId: string;
      teamRole: "lead";
    };
  };
  request: {
    sessionId: string;
    peerAgentId: string;
    peerAgentVersion: number;
    prompt: string;
    parentSessionId: string;
    title: string | null;
    skipSpawn: boolean;
    provisionSandbox: boolean;
    sandboxTemplate: string | null;
  };
};

export type StaleTeamMemberLaunch = {
  memberId: string;
  teamId: string;
  sessionId: string;
  operationId: string;
  kind: TeamMemberLaunchKind;
  startedAt: Date;
  cleanupRequestedAt: Date | null;
  cleanupAction: TeamMemberLaunchCleanupAction | null;
  previousSessionId: string | null;
  previousStatus: TerminalTeamMemberStatus | null;
  /** Published runtime generation observed by the bounded candidate scan. */
  runtimeAppId: string | null;
  daprInstanceId: string | null;
  /** Provisioning generation token observed by the bounded candidate scan. */
  runtimeProvisioningStartedAt: Date | null;
};

export type TeamMemberLaunchReconcileResult =
  | { status: "promoted" }
  | { status: "pending" }
  | { status: "cleanup"; action: TeamMemberLaunchCleanupAction }
  | { status: "stale" };

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
	/** The RESULTS channel: the deliverable (or a pointer to it) the completer
	 * passed via update_task(taskId, "completed", note). */
	completion_note: string | null;
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
	completion_note: string | null;
};

export type TeamKnowledgeRow = {
	id: string;
	team_id: string;
	path: string;
	type: string;
	title: string | null;
	description: string | null;
	/** OKF §4.1: URI of the underlying asset (absent for abstract concepts). */
	resource: string | null;
	tags: string[];
	body: string;
	created_by_session_id: string | null;
	created_at: string;
	updated_at: string;
};

export type TeamKnowledgeIndexEntry = Omit<
  TeamKnowledgeRow,
  "body" | "id" | "team_id"
>;

export type UpsertTeamKnowledgeInput = {
	teamId: string;
	/** Sanitized bundle-relative path ('findings/use-cases.md'). */
	path: string;
	type: string;
	title?: string | null;
	description?: string | null;
	resource?: string | null;
	tags?: string[];
	body: string;
	createdBySessionId?: string | null;
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

export type TeamMemberSpawnReservationInput = AddMemberInput;

export type BeginTeamMemberSpawnInput = TeamMemberSpawnReservationInput & {
  dispatchRecipe: TeamMemberPeerDispatchRecipe;
};

export type TeamMemberRevivalReservationInput = {
  teamId: string;
  memberId: string;
  previousSessionId: string;
  previousStatus: TerminalTeamMemberStatus;
  sessionId: string;
};

export type BeginTeamMemberRevivalInput = TeamMemberRevivalReservationInput & {
  dispatchRecipe: TeamMemberPeerDispatchRecipe;
};

export type TeamMemberLaunchReservation = {
  member: TeamMemberRow;
  state: "acquired" | "reserved" | "in_flight" | "active";
  dispatchRecipe: TeamMemberPeerDispatchRecipe;
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
  /**
   * Reserve a new identity in a non-working state before peer dispatch. The
   * adapter must fence the active team, lead session, and team execution. An
   * exact deterministic retry may return its existing starting or working
   * launch; a conflicting caller returns null.
   */
  beginMemberSpawn(
    input: BeginTeamMemberSpawnInput,
  ): Promise<TeamMemberLaunchReservation | null>;
  /** Read one exact durable spawn receipt without reserving new work. */
  findMemberSpawnReplay(
    input: TeamMemberSpawnReservationInput,
  ): Promise<TeamMemberLaunchReservation | null>;
  /**
   * Move an exact terminal identity onto its deterministic replacement in the
   * non-working starting state. An exact retry may resume that same starting
   * or working revival operation.
   */
  beginMemberRevival(
    input: BeginTeamMemberRevivalInput,
  ): Promise<TeamMemberLaunchReservation | null>;
  /** Read the current durable revival receipt by stable team/name identity. */
  findMemberRevivalReplay(input: {
    teamId: string;
    name: string;
  }): Promise<TeamMemberLaunchReservation | null>;
  /** Promote only an exact starting mapping whose child, lead, and execution remain active. */
  promoteStartingMember(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean>;
  /** Durably fence an exact starting launch so only cleanup may proceed. */
  requestMemberLaunchCleanup(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<{ action: TeamMemberLaunchCleanupAction } | null>;
  /** Delete an exact unlaunched new-member reservation. */
  cancelMemberSpawn(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean>;
  /** Restore an exact revival reservation to its terminal predecessor. */
  cancelMemberRevival(
    input: TeamMemberRevivalReservationInput & { operationId: string },
  ): Promise<boolean>;
  /** Bounded oldest-first scan used by the periodic launch reconciler. */
  listStaleMemberLaunches(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<StaleTeamMemberLaunch[]>;
  /**
   * Atomically prove and promote the exact published child generation, defer an
   * in-flight provisioning lease, or durably fence the operation for cleanup.
   */
  reconcileStaleMemberLaunch(
    input: StaleTeamMemberLaunch,
  ): Promise<TeamMemberLaunchReconcileResult>;
  /** Delete a new reservation or restore the persisted revival predecessor. */
  completeMemberLaunchCleanup(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean>;
	listMembers(teamId: string): Promise<TeamMemberRow[]>;
	getTeam(teamId: string): Promise<TeamRow | null>;
	getMemberByName(teamId: string, name: string): Promise<TeamMemberRow | null>;
	getMemberBySession(sessionId: string): Promise<TeamMemberRow | null>;
	listIdleMembers(): Promise<TeamMemberRow[]>;
  /**
   * Compare-and-set a live teammate status. The adapter must update only when
   * the member is nonterminal, its session has no stop intent, the session is
   * nonterminal, and the member is in one of `expectedStatuses`.
   */
  transitionActiveMemberStatus(input: {
    sessionId: string;
    expectedStatuses: readonly ActiveTeamMemberStatus[];
    status: ActiveTeamMemberStatus;
  }): Promise<boolean>;
  /** Mark a nonterminal teammate failed without overwriting stop/shutdown. */
  transitionMemberToFailed(sessionId: string): Promise<boolean>;
  /**
   * Finalize shutdown for the exact member/session pair resolved before the
   * lifecycle call. `stale` means revival or deletion won the race.
   */
  finalizeMemberShutdown(input: {
    memberId: string;
    sessionId: string;
  }): Promise<TeamMemberShutdownFinalizeResult>;
  resolveAgentIdBySlug(
    projectId: string,
    slug: string,
  ): Promise<{ id: string } | null>;

	/** Tokens consumed by the whole team so far: sum of agent.llm_usage
	 * input+output across every member session. Feeds the token-budget gate
	 * (Codex RolloutBudget parity). */
	getTeamTokensUsed(teamId: string): Promise<number>;

  /**
   * Compare-and-set a terminal member onto its replacement session. The
   * adapter must verify the exact predecessor mapping and that the replacement,
   * its lead, and any linked workflow execution are still active. Replays that
   * already installed the same replacement are successful.
   */
	setMemberSession(input: {
		memberId: string;
    previousSessionId: string;
		sessionId: string;
		status?: TeamMemberStatus;
  }): Promise<boolean>;

	/** Flip plan_mode_required off once the lead approves the member's plan. */
	setMemberPlanApproved(sessionId: string): Promise<void>;

	// ── shared knowledge (OKF-shaped content layer) ───────────────────────────

	/** Publish/revise one concept document (upsert on (team, path)). */
	upsertKnowledge(input: UpsertTeamKnowledgeInput): Promise<TeamKnowledgeRow>;
	/** Bundle index: frontmatter-level fields for every concept, no bodies. */
	listKnowledge(
		teamId: string,
		filter?: { type?: string },
	): Promise<TeamKnowledgeIndexEntry[]>;
	/** One full concept document, or null. */
	getKnowledge(teamId: string, path: string): Promise<TeamKnowledgeRow | null>;

	/** Live activity across every member session: the latest classifiable event
	 * per member (the "now" board) + a recent merged stream. Feeds the Live
	 * tab's team board; poll-friendly (two indexed queries). */
  getTeamLiveActivity(input: {
    teamId: string;
    streamLimit?: number;
  }): Promise<{
		members: Array<{
			name: string;
			role: string;
			status: string;
			session_id: string;
			event_type: string | null;
			tool_name: string | null;
			tool_path: string | null;
			origin: string | null;
			from_agent: string | null;
			preview: string | null;
			event_at: string | null;
		}>;
		stream: Array<{
			name: string;
			session_id: string;
			event_type: string;
			tool_name: string | null;
			tool_path: string | null;
			origin: string | null;
			from_agent: string | null;
			preview: string | null;
			event_at: string;
		}>;
	}>;

	// shared task list (atomic claim)
	listTeamTasks(teamId: string): Promise<TeamTaskListItem[]>;
	createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow>;
  claimNextTask(input: {
    teamId: string;
    sessionId: string;
  }): Promise<TeamTaskRow | null>;
	countClaimableTasks(teamId: string): Promise<number>;
	completeTask(input: {
		teamId: string;
		taskId: string;
		/** Deliverable text (or pointer) persisted as completion_note. */
		note?: string | null;
	}): Promise<TeamTaskRow | null>;

	/** One-query snapshot for the wake-on-deliver decision (team-delivery.ts). */
	getSessionDeliveryState(sessionId: string): Promise<{
		status: string;
    stopRequested: boolean;
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
    runtimeDesiredRunning: boolean;
	} | null>;

  /**
   * Atomically own either message delivery (desired running) or idle suspension
   * (desired suspended). A live opposite operation cannot be stolen. Once stale,
   * takeover follows the current authoritative need: queued work selects delivery,
   * while an idle mailbox selects suspension. Exact tokens fence the old owner.
   */
  claimRuntimeOperation(input: {
    sessionId: string;
    operation: TeamRuntimeOperation;
    staleAfterSeconds: number;
  }): Promise<TeamRuntimeOperationLease | null>;
  /** Recheck exact ownership and desired state immediately before a side effect. */
  verifyRuntimeOperation(input: {
    sessionId: string;
    operationId: string;
    operation: TeamRuntimeOperation;
    desiredRunning: boolean;
  }): Promise<boolean>;
  /**
   * Release an exact lease. `memberStatus` is applied only while the linked
   * session/member remain active; terminal lifecycle state is never overwritten.
   */
  finishRuntimeOperation(input: {
    sessionId: string;
    operationId: string;
    operation: TeamRuntimeOperation;
    memberStatus?: ActiveTeamMemberStatus;
    desiredRunning?: boolean;
  }): Promise<boolean>;

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

  /** Runtime-backed team sessions holding unraised team-origin messages older than the
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
  stampLeadSessionExecution(
    sessionId: string,
    executionId: string,
  ): Promise<void>;
	linkSessionToExecution(sessionId: string, executionId: string): Promise<void>;
	refreshTeamRunStatus(teamId: string): Promise<void>;
}
