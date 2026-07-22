/**
 * Agent Teams — Postgres persistence adapter (implements the `TeamStore` port).
 *
 * Owns every raw SQL statement for the teams feature: team + membership rows,
 * the shared task list (the atomic `FOR UPDATE SKIP LOCKED` claim), and the
 * team-run container-execution rollup. Kept as `db.execute(sql\`...\`)` (like the
 * goal-loop store) so it runs against both postgres-js and PGlite — the teams
 * unit tests construct this adapter over a PGlite db.
 */

import { sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db as defaultDb } from "$lib/server/db";
import { toPostgresTimestampParam } from "$lib/server/db/sql-params";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
  ActiveTeamMemberStatus,
	AddMemberInput,
  BeginTeamMemberRevivalInput,
  BeginTeamMemberSpawnInput,
	CreateTeamTaskInput,
	EnsureTeamInput,
	TeamKnowledgeIndexEntry,
	TeamKnowledgeRow,
  TeamMemberLaunchCleanupAction,
  TeamMemberLaunchReconcileResult,
  TeamMemberLaunchReservation,
  TeamMemberPeerDispatchRecipe,
	TeamMemberRow,
  TeamMemberShutdownFinalizeResult,
	TeamMemberStatus,
	TeamRow,
  TeamRuntimeOperation,
  TeamRuntimeOperationLease,
  TeamMemberRevivalReservationInput,
  TeamMemberSpawnReservationInput,
  StaleTeamMemberLaunch,
  TerminalTeamMemberStatus,
	TeamStore,
	TeamTaskListItem,
	TeamTaskRow,
	UpsertTeamKnowledgeInput,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

function rows<T>(r: unknown): T[] {
	return r as T[];
}

type LaunchReplayRow = TeamMemberRow & {
  child_id: string | null;
  child_agent_id: string | null;
  child_agent_version: number | null;
  authority_lead_session_id: string;
  authority_user_id: string;
  authority_project_id: string;
};

type LaunchOwnership = {
  teamId: string;
  workflowExecutionId: string | null;
  leadSessionId: string;
  projectId: string;
};

type LaunchChildRow = {
  id: string;
  parent_execution_id: string | null;
  workflow_execution_id: string | null;
  status: string;
  stop_requested_at: Date | null;
  completed_at: Date | null;
  dapr_instance_id: string | null;
  runtime_app_id: string | null;
  runtime_provisioning_started_at: Date | string | null;
  agent_id: string;
  agent_version: number | null;
  user_id: string;
  project_id: string | null;
};

function childOwnedByLaunch(
  child: LaunchChildRow | null,
  launch: LaunchOwnership,
  recipe: TeamMemberPeerDispatchRecipe,
): boolean {
  return Boolean(
    child &&
    child.parent_execution_id === launch.leadSessionId &&
    child.workflow_execution_id === launch.workflowExecutionId &&
    child.agent_id === recipe.request.peerAgentId &&
    child.agent_version === recipe.request.peerAgentVersion &&
    child.user_id === recipe.principal.userId &&
    child.project_id === recipe.principal.projectId &&
    recipe.teamId === launch.teamId &&
    recipe.principal.sessionId === launch.leadSessionId &&
    recipe.principal.projectId === launch.projectId,
  );
}

function sameDispatchRecipe(
  left: TeamMemberPeerDispatchRecipe,
  right: TeamMemberPeerDispatchRecipe,
): boolean {
  return (
    left.version === right.version &&
    left.teamId === right.teamId &&
    left.principal.userId === right.principal.userId &&
    left.principal.projectId === right.principal.projectId &&
    left.principal.sessionId === right.principal.sessionId &&
    left.principal.capabilities.scriptDepth ===
      right.principal.capabilities.scriptDepth &&
    left.principal.capabilities.teamId ===
      right.principal.capabilities.teamId &&
    left.principal.capabilities.teamRole ===
      right.principal.capabilities.teamRole &&
    left.request.sessionId === right.request.sessionId &&
    left.request.peerAgentId === right.request.peerAgentId &&
    left.request.peerAgentVersion === right.request.peerAgentVersion &&
    left.request.prompt === right.request.prompt &&
    left.request.parentSessionId === right.request.parentSessionId &&
    left.request.title === right.request.title &&
    left.request.skipSpawn === right.request.skipSpawn &&
    left.request.provisionSandbox === right.request.provisionSandbox &&
    left.request.sandboxTemplate === right.request.sandboxTemplate
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameTimestamp(
  left: Date | string | null,
  right: Date | string | null,
): boolean {
  if (left === null || right === null) return left === right;
  const leftMs =
    left instanceof Date ? left.getTime() : new Date(left).getTime();
  const rightMs =
    right instanceof Date ? right.getTime() : new Date(right).getTime();
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function parseDispatchRecipe(
  value: unknown,
): TeamMemberPeerDispatchRecipe | null {
  const recipe = record(value);
  const principal = record(recipe?.principal);
  const capabilities = record(principal?.capabilities);
  const request = record(recipe?.request);
  if (
    recipe?.version !== 1 ||
    !nonEmptyString(recipe.teamId) ||
    !nonEmptyString(principal?.userId) ||
    !nonEmptyString(principal?.projectId) ||
    !nonEmptyString(principal?.sessionId) ||
    !Number.isSafeInteger(capabilities?.scriptDepth) ||
    (capabilities?.scriptDepth as number) < 0 ||
    capabilities?.teamId !== recipe.teamId ||
    capabilities?.teamRole !== "lead" ||
    !nonEmptyString(request?.sessionId) ||
    !nonEmptyString(request?.peerAgentId) ||
    !Number.isSafeInteger(request?.peerAgentVersion) ||
    (request?.peerAgentVersion as number) < 1 ||
    typeof request?.prompt !== "string" ||
    !nonEmptyString(request?.parentSessionId) ||
    (request?.title !== null && typeof request?.title !== "string") ||
    typeof request?.skipSpawn !== "boolean" ||
    typeof request?.provisionSandbox !== "boolean" ||
    (request?.sandboxTemplate !== null &&
      typeof request?.sandboxTemplate !== "string") ||
    request.parentSessionId !== principal.sessionId
  ) {
    return null;
  }
  return {
    version: 1,
    teamId: recipe.teamId,
    principal: {
      userId: principal.userId,
      projectId: principal.projectId,
      sessionId: principal.sessionId,
      capabilities: {
        scriptDepth: capabilities.scriptDepth as number,
        teamId: capabilities.teamId as string,
        teamRole: "lead",
      },
    },
    request: {
      sessionId: request.sessionId,
      peerAgentId: request.peerAgentId,
      peerAgentVersion: request.peerAgentVersion as number,
      prompt: request.prompt,
      parentSessionId: request.parentSessionId,
      title: request.title as string | null,
      skipSpawn: request.skipSpawn,
      provisionSandbox: request.provisionSandbox,
      sandboxTemplate: request.sandboxTemplate as string | null,
    },
  };
}

function launchReservation(
  row: LaunchReplayRow | TeamMemberRow,
  state: TeamMemberLaunchReservation["state"],
): TeamMemberLaunchReservation | null {
  const dispatchRecipe = parseDispatchRecipe(row.launch_dispatch_recipe);
  if (!dispatchRecipe) return null;
  const replay = row as Partial<LaunchReplayRow>;
  if (
    Object.prototype.hasOwnProperty.call(replay, "authority_lead_session_id") &&
    (replay.authority_lead_session_id !== dispatchRecipe.principal.sessionId ||
      replay.authority_user_id !== dispatchRecipe.principal.userId ||
      replay.authority_project_id !== dispatchRecipe.principal.projectId ||
      dispatchRecipe.teamId !== row.team_id ||
      dispatchRecipe.request.sessionId !== row.session_id)
  ) {
    return null;
  }
  if (
    replay.child_id &&
    (replay.child_agent_id !== dispatchRecipe.request.peerAgentId ||
      replay.child_agent_version !== dispatchRecipe.request.peerAgentVersion)
  ) {
    return null;
  }
  const {
    child_id: _childId,
    child_agent_id: _childAgentId,
    child_agent_version: _childAgentVersion,
    authority_lead_session_id: _authorityLeadSessionId,
    authority_user_id: _authorityUserId,
    authority_project_id: _authorityProjectId,
    ...rawMember
  } = row as LaunchReplayRow;
  const member: TeamMemberRow = {
    ...rawMember,
    launch_dispatch_recipe: dispatchRecipe,
  };
  return { member, state, dispatchRecipe };
}

/** One shared synthetic "Agent Team Runs" workflow per project (satisfies the
 * non-null workflow_executions.workflowId FK without a schema migration). */
function teamRunWorkflowId(projectId: string): string {
	return `team-run-wf-${projectId}`;
}

export class PostgresTeamStore implements TeamStore {
  constructor(
    private readonly getDatabase: () => Database = requirePostgresDb,
  ) {}

	private get db(): Database {
		return this.getDatabase();
	}

	// ── teams + membership ──────────────────────────────────────────────────

	async ensureTeam(input: EnsureTeamInput): Promise<void> {
		await this.db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id, token_budget)
			VALUES (
				${input.teamId}, ${input.workflowExecutionId ?? null}, ${input.projectId},
				${input.name ?? `team-${input.teamId.slice(0, 8)}`}, ${input.leadSessionId},
				${input.tokenBudget ?? null}
			)
			ON CONFLICT (id) DO NOTHING
		`);
		// Ensure the lead is a member (role=lead). Its own session id is the member key.
		await this.db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES (${nanoid()}, ${input.teamId}, ${input.leadSessionId}, 'lead', 'lead', 'working')
			ON CONFLICT (session_id) DO NOTHING
		`);
	}

	async addMember(input: AddMemberInput): Promise<TeamMemberRow> {
		const r = await this.db.execute<TeamMemberRow>(sql`
			INSERT INTO team_members
				(id, team_id, session_id, agent_slug, name, role, model, plan_mode_required, status)
			VALUES (
				${nanoid()}, ${input.teamId}, ${input.sessionId}, ${input.agentSlug ?? null},
				${input.name}, 'member', ${input.model ?? null}, ${input.planModeRequired ?? false}, 'working'
			)
			ON CONFLICT (session_id) DO UPDATE SET
				status = CASE
					WHEN team_members.status IN ('failed', 'shutdown') THEN team_members.status
					ELSE 'working'
				END,
				updated_at = now()
			RETURNING *
		`);
		return rows<TeamMemberRow>(r)[0];
	}

  async beginMemberSpawn(
    input: BeginTeamMemberSpawnInput,
  ): Promise<TeamMemberLaunchReservation | null> {
    const operationId = nanoid();
    const r = await this.db.execute<TeamMemberRow>(sql`
			INSERT INTO team_members
				(id, team_id, session_id, agent_slug, name, role, model,
				 plan_mode_required, status, launch_operation_id, launch_kind,
				 launch_started_at, launch_dispatch_recipe)
			SELECT
				${nanoid()}, team.id, ${input.sessionId}, ${input.agentSlug ?? null},
				${input.name}, 'member', ${input.model ?? null},
				${input.planModeRequired ?? false}, 'starting', ${operationId}, 'spawn',
				clock_timestamp(), ${JSON.stringify(input.dispatchRecipe)}::jsonb
			FROM teams AS team
			JOIN sessions AS lead ON lead.id = team.lead_session_id
			WHERE team.id = ${input.teamId}
			  AND team.id = ${input.dispatchRecipe.teamId}
			  AND team.project_id = ${input.dispatchRecipe.principal.projectId}
			  AND lead.id = ${input.dispatchRecipe.principal.sessionId}
			  AND lead.user_id = ${input.dispatchRecipe.principal.userId}
			  AND lead.project_id = ${input.dispatchRecipe.principal.projectId}
			  AND team.status = 'active'
			  AND lead.stop_requested_at IS NULL
			  AND lead.completed_at IS NULL
			  AND lead.status IN ('rescheduling', 'running', 'idle')
				  AND (
					team.workflow_execution_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workflow_executions AS execution
					WHERE execution.id = team.workflow_execution_id
					  AND execution.user_id = lead.user_id
					  AND execution.project_id = team.project_id
					  AND execution.stop_requested_at IS NULL
					  AND execution.completed_at IS NULL
					  AND execution.status IN ('pending', 'running')
					)
				  )
				  AND NOT EXISTS (
					SELECT 1 FROM sessions AS existing_child
					WHERE existing_child.id = ${input.sessionId}
				  )
				ON CONFLICT DO NOTHING
			RETURNING *
		`);
    const reserved = rows<TeamMemberRow>(r)[0];
    if (reserved) return launchReservation(reserved, "acquired");
    return this.findMemberSpawnReplayWithRecipe(input, input.dispatchRecipe);
  }

  async findMemberSpawnReplay(
    input: TeamMemberSpawnReservationInput,
  ): Promise<TeamMemberLaunchReservation | null> {
    return this.findMemberSpawnReplayWithRecipe(input);
  }

  private async findMemberSpawnReplayWithRecipe(
    input: TeamMemberSpawnReservationInput,
    expectedRecipe?: TeamMemberPeerDispatchRecipe,
  ): Promise<TeamMemberLaunchReservation | null> {
    // A transport retry can arrive after the first request reserved or even
    // promoted this deterministic teammate. Resume only that exact launch;
    // conflicting names, sessions, options, or inactive lineage still fail.
    const replay = await this.db.execute<LaunchReplayRow>(sql`
			SELECT member.*, child.id AS child_id,
			       child.agent_id AS child_agent_id,
			       child.agent_version AS child_agent_version,
			       team.lead_session_id AS authority_lead_session_id,
			       lead.user_id AS authority_user_id,
			       team.project_id AS authority_project_id
			FROM team_members AS member
			JOIN teams AS team ON team.id = member.team_id
			JOIN sessions AS lead ON lead.id = team.lead_session_id
			LEFT JOIN sessions AS child ON child.id = member.session_id
			WHERE member.team_id = ${input.teamId}
			  AND member.session_id = ${input.sessionId}
			  AND member.name = ${input.name}
			  AND member.role = 'member'
			  AND member.agent_slug IS NOT DISTINCT FROM ${input.agentSlug ?? null}
			  AND member.model IS NOT DISTINCT FROM ${input.model ?? null}
			  AND member.plan_mode_required = ${input.planModeRequired ?? false}
			  AND member.launch_kind = 'spawn'
			  AND member.launch_operation_id IS NOT NULL
			  AND member.launch_cleanup_requested_at IS NULL
			  AND (
				(
				  member.status = 'starting'
				  AND (
					child.id IS NULL
					OR (
					  child.parent_execution_id = team.lead_session_id
					  AND child.workflow_execution_id IS NOT DISTINCT FROM team.workflow_execution_id
					  AND child.status IN ('rescheduling', 'running', 'idle')
					  AND child.stop_requested_at IS NULL
					  AND child.completed_at IS NULL
					)
				  )
				)
				OR (
				  member.status = 'working'
				  AND child.parent_execution_id = team.lead_session_id
				  AND child.workflow_execution_id IS NOT DISTINCT FROM team.workflow_execution_id
				  AND child.status IN ('rescheduling', 'running', 'idle')
				  AND child.stop_requested_at IS NULL
				  AND child.completed_at IS NULL
				  AND child.dapr_instance_id IS NOT NULL
				  AND child.runtime_app_id IS NOT NULL
				)
			  )
			  AND team.status = 'active'
			  AND lead.stop_requested_at IS NULL
			  AND lead.completed_at IS NULL
			  AND lead.status IN ('rescheduling', 'running', 'idle')
			  AND (
				team.workflow_execution_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workflow_executions AS execution
					WHERE execution.id = team.workflow_execution_id
					  AND execution.user_id = lead.user_id
					  AND execution.project_id = team.project_id
					  AND execution.stop_requested_at IS NULL
					  AND execution.completed_at IS NULL
					  AND execution.status IN ('pending', 'running')
				)
			  )
			LIMIT 1
		`);
    const replayed = rows<LaunchReplayRow>(replay)[0];
    if (!replayed) return null;
    const reservation = launchReservation(
      replayed,
      replayed.status === "working"
        ? "active"
        : replayed.child_id
          ? "in_flight"
          : "reserved",
    );
    return reservation &&
      expectedRecipe &&
      !sameDispatchRecipe(reservation.dispatchRecipe, expectedRecipe)
      ? null
      : reservation;
  }

  async beginMemberRevival(
    input: BeginTeamMemberRevivalInput,
  ): Promise<TeamMemberLaunchReservation | null> {
    const operationId = nanoid();
    const r = await this.db.execute<TeamMemberRow>(sql`
			UPDATE team_members AS member
			SET session_id = ${input.sessionId},
				status = 'starting',
				launch_operation_id = ${operationId},
				launch_kind = 'revival',
				launch_started_at = clock_timestamp(),
					launch_completed_at = NULL,
					launch_cleanup_requested_at = NULL,
					launch_cleanup_action = NULL,
				launch_previous_session_id = ${input.previousSessionId},
				launch_previous_status = ${input.previousStatus},
				launch_dispatch_recipe = ${JSON.stringify(input.dispatchRecipe)}::jsonb,
				updated_at = clock_timestamp()
			FROM teams AS team
			WHERE member.id = ${input.memberId}
			  AND member.team_id = ${input.teamId}
			  AND member.team_id = team.id
			  AND team.id = ${input.dispatchRecipe.teamId}
			  AND team.project_id = ${input.dispatchRecipe.principal.projectId}
			  AND member.role <> 'lead'
			  AND member.session_id = ${input.previousSessionId}
			  AND member.status = ${input.previousStatus}
			  AND team.status = 'active'
			  AND EXISTS (
				SELECT 1 FROM sessions AS lead
				WHERE lead.id = team.lead_session_id
				  AND lead.id = ${input.dispatchRecipe.principal.sessionId}
				  AND lead.user_id = ${input.dispatchRecipe.principal.userId}
				  AND lead.project_id = ${input.dispatchRecipe.principal.projectId}
				  AND lead.stop_requested_at IS NULL
				  AND lead.completed_at IS NULL
				  AND lead.status IN ('rescheduling', 'running', 'idle')
			  )
			  AND (
				team.workflow_execution_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workflow_executions AS execution
					WHERE execution.id = team.workflow_execution_id
					  AND execution.user_id = ${input.dispatchRecipe.principal.userId}
					  AND execution.project_id = ${input.dispatchRecipe.principal.projectId}
					  AND execution.stop_requested_at IS NULL
					  AND execution.completed_at IS NULL
					  AND execution.status IN ('pending', 'running')
					)
				  )
				  AND NOT EXISTS (
					SELECT 1 FROM sessions AS existing_child
					WHERE existing_child.id = ${input.sessionId}
				  )
				RETURNING member.*
		`);
    const reserved = rows<TeamMemberRow>(r)[0];
    if (reserved) return launchReservation(reserved, "acquired");
    return this.findExactMemberRevivalReplay(input, input.dispatchRecipe);
  }

  private async findExactMemberRevivalReplay(
    input: TeamMemberRevivalReservationInput,
    expectedRecipe?: TeamMemberPeerDispatchRecipe,
  ): Promise<TeamMemberLaunchReservation | null> {
    const replay = await this.db.execute<LaunchReplayRow>(sql`
			SELECT member.*, child.id AS child_id,
			       child.agent_id AS child_agent_id,
			       child.agent_version AS child_agent_version,
			       team.lead_session_id AS authority_lead_session_id,
			       lead.user_id AS authority_user_id,
			       team.project_id AS authority_project_id
			FROM team_members AS member
			JOIN teams AS team ON team.id = member.team_id
			JOIN sessions AS lead ON lead.id = team.lead_session_id
			LEFT JOIN sessions AS child ON child.id = member.session_id
			WHERE member.id = ${input.memberId}
			  AND member.team_id = ${input.teamId}
			  AND member.session_id = ${input.sessionId}
			  AND member.role <> 'lead'
			  AND member.launch_kind = 'revival'
			  AND member.launch_operation_id IS NOT NULL
			  AND member.launch_previous_session_id = ${input.previousSessionId}
			  AND member.launch_previous_status = ${input.previousStatus}
			  AND member.launch_cleanup_requested_at IS NULL
			  AND (
				(
				  member.status = 'starting'
				  AND (
					child.id IS NULL
					OR (
					  child.parent_execution_id = team.lead_session_id
					  AND child.workflow_execution_id IS NOT DISTINCT FROM team.workflow_execution_id
					  AND child.status IN ('rescheduling', 'running', 'idle')
					  AND child.stop_requested_at IS NULL
					  AND child.completed_at IS NULL
					)
				  )
				)
				OR (
				  member.status = 'working'
				  AND child.parent_execution_id = team.lead_session_id
				  AND child.workflow_execution_id IS NOT DISTINCT FROM team.workflow_execution_id
				  AND child.status IN ('rescheduling', 'running', 'idle')
				  AND child.stop_requested_at IS NULL
				  AND child.completed_at IS NULL
				  AND child.dapr_instance_id IS NOT NULL
				  AND child.runtime_app_id IS NOT NULL
				)
			  )
			  AND team.status = 'active'
			  AND lead.stop_requested_at IS NULL
			  AND lead.completed_at IS NULL
			  AND lead.status IN ('rescheduling', 'running', 'idle')
			  AND (
				team.workflow_execution_id IS NULL
				OR EXISTS (
					SELECT 1 FROM workflow_executions AS execution
					WHERE execution.id = team.workflow_execution_id
					  AND execution.user_id = lead.user_id
					  AND execution.project_id = team.project_id
					  AND execution.stop_requested_at IS NULL
					  AND execution.completed_at IS NULL
					  AND execution.status IN ('pending', 'running')
				)
			  )
			LIMIT 1
		`);
    const replayed = rows<LaunchReplayRow>(replay)[0];
    if (!replayed) return null;
    const reservation = launchReservation(
      replayed,
      replayed.status === "working"
        ? "active"
        : replayed.child_id
          ? "in_flight"
          : "reserved",
    );
    return reservation &&
      expectedRecipe &&
      !sameDispatchRecipe(reservation.dispatchRecipe, expectedRecipe)
      ? null
      : reservation;
  }

  async findMemberRevivalReplay(input: {
    teamId: string;
    name: string;
  }): Promise<TeamMemberLaunchReservation | null> {
    const member = await this.getMemberByName(input.teamId, input.name);
    if (
      !member ||
      member.launch_kind !== "revival" ||
      !member.launch_operation_id ||
      !member.launch_previous_session_id ||
      (member.launch_previous_status !== "failed" &&
        member.launch_previous_status !== "shutdown")
    ) {
      return null;
    }
    return this.findExactMemberRevivalReplay({
      teamId: input.teamId,
      memberId: member.id,
      previousSessionId: member.launch_previous_session_id,
      previousStatus: member.launch_previous_status,
      sessionId: member.session_id,
    });
  }

  async promoteStartingMember(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean> {
    const result = await this.resolveStartingMemberLaunch(input);
    return result.status === "promoted";
  }

  async requestMemberLaunchCleanup(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<{ action: TeamMemberLaunchCleanupAction } | null> {
    return this.db.transaction(async (tx) => {
      const candidates = rows<{
        team_id: string;
        workflow_execution_id: string | null;
        lead_session_id: string;
        project_id: string;
      }>(
        await tx.execute(sql`
						SELECT member.team_id, team.workflow_execution_id,
						       team.lead_session_id, team.project_id
					FROM team_members AS member
					JOIN teams AS team ON team.id = member.team_id
					WHERE member.id = ${input.memberId}
					  AND member.session_id = ${input.sessionId}
					  AND member.launch_operation_id = ${input.operationId}
						  AND member.launch_kind IN ('spawn', 'revival')
						  AND member.role <> 'lead'
						  AND member.status = 'starting'
					`),
      );
      const candidate = candidates[0];
      if (!candidate) return null;

      const children = rows<LaunchChildRow>(
        await tx.execute(sql`
					SELECT child.id, child.parent_execution_id,
					       child.workflow_execution_id, child.status,
					       child.agent_id, child.agent_version,
					       child.user_id, child.project_id,
					       child.stop_requested_at, child.completed_at,
					       child.dapr_instance_id, child.runtime_app_id,
					       child.runtime_provisioning_started_at
					FROM sessions AS child
					WHERE child.id = ${input.sessionId}
					FOR UPDATE OF child
				`),
      );
      const ownership: LaunchOwnership = {
        teamId: candidate.team_id,
        workflowExecutionId: candidate.workflow_execution_id,
        leadSessionId: candidate.lead_session_id,
        projectId: candidate.project_id,
      };
      const lockedMembers = rows<{
        launch_cleanup_action: TeamMemberLaunchCleanupAction | null;
        launch_dispatch_recipe: unknown;
      }>(
        await tx.execute(sql`
						SELECT member.launch_cleanup_action, member.launch_dispatch_recipe
						FROM team_members AS member
						WHERE member.id = ${input.memberId}
						  AND member.team_id = ${candidate.team_id}
						  AND member.session_id = ${input.sessionId}
						  AND member.launch_operation_id = ${input.operationId}
						  AND member.launch_kind IN ('spawn', 'revival')
						  AND member.role <> 'lead'
						  AND member.status = 'starting'
						FOR UPDATE OF member
					`),
      );
      const lockedMember = lockedMembers[0];
      if (!lockedMember) return null;
      const recipe = parseDispatchRecipe(lockedMember.launch_dispatch_recipe);
      const child = children[0] ?? null;
      let requestedAction: TeamMemberLaunchCleanupAction =
        lockedMember.launch_cleanup_action === "unwind" ||
        !recipe ||
        !childOwnedByLaunch(child, ownership, recipe)
          ? "unwind"
          : "purge";
      if (requestedAction === "purge" && child && recipe) {
        const fenced = rows<{ id: string }>(
          await tx.execute(sql`
							WITH stop_intent AS (
								SELECT clock_timestamp() AS requested_at
							)
							UPDATE sessions
							SET stop_requested_at = COALESCE(
									stop_requested_at,
									stop_intent.requested_at
								),
								stop_requested_mode = CASE
									WHEN stop_requested_at IS NULL THEN 'purge'
									WHEN stop_requested_mode = 'reset' THEN 'reset'
									ELSE 'purge'
								END,
								updated_at = CASE
									WHEN stop_requested_at IS NULL THEN stop_intent.requested_at
									ELSE updated_at
								END
							FROM stop_intent
							WHERE id = ${input.sessionId}
							  AND parent_execution_id = ${ownership.leadSessionId}
							  AND workflow_execution_id IS NOT DISTINCT FROM ${ownership.workflowExecutionId}
							  AND agent_id = ${recipe.request.peerAgentId}
							  AND agent_version = ${recipe.request.peerAgentVersion}
							  AND user_id = ${recipe.principal.userId}
							  AND project_id = ${recipe.principal.projectId}
							  AND dapr_instance_id IS NOT DISTINCT FROM ${child.dapr_instance_id}
							  AND runtime_app_id IS NOT DISTINCT FROM ${child.runtime_app_id}
							  AND runtime_provisioning_started_at IS NOT DISTINCT FROM ${
									child.runtime_provisioning_started_at == null
										? null
										: toPostgresTimestampParam(
												child.runtime_provisioning_started_at,
											)
								}
							RETURNING id
						`),
        );
        if (fenced.length === 0) requestedAction = "unwind";
      }
      const marked = rows<{
        launch_cleanup_action: TeamMemberLaunchCleanupAction;
      }>(
        await tx.execute(sql`
					UPDATE team_members
					SET launch_cleanup_requested_at = COALESCE(
							launch_cleanup_requested_at,
							clock_timestamp()
						),
							launch_cleanup_action = CASE
								WHEN launch_cleanup_action = 'unwind'
								  OR ${requestedAction} = 'unwind'
								THEN 'unwind'
								ELSE 'purge'
							END,
						updated_at = clock_timestamp()
					WHERE id = ${input.memberId}
					  AND session_id = ${input.sessionId}
					  AND launch_operation_id = ${input.operationId}
					  AND launch_kind IN ('spawn', 'revival')
					  AND role <> 'lead'
					  AND status = 'starting'
					RETURNING launch_cleanup_action
				`),
      );
      return marked[0] ? { action: marked[0].launch_cleanup_action } : null;
    });
  }

  private async resolveStartingMemberLaunch(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
    expectedRuntimeAppId?: string | null;
    expectedDaprInstanceId?: string | null;
    expectedRuntimeProvisioningStartedAt?: Date | null;
  }): Promise<TeamMemberLaunchReconcileResult> {
    const database = this.db;
    return database.transaction(async (tx) => {
      const markForCleanup = async (
        action: TeamMemberLaunchCleanupAction,
      ): Promise<TeamMemberLaunchReconcileResult> => {
        const marked = rows<{
          launch_cleanup_action: TeamMemberLaunchCleanupAction;
        }>(
          await tx.execute(sql`
						UPDATE team_members
						SET launch_cleanup_requested_at = COALESCE(
								launch_cleanup_requested_at,
								clock_timestamp()
							),
								launch_cleanup_action = CASE
									WHEN launch_cleanup_action = 'unwind'
									  OR ${action} = 'unwind'
									THEN 'unwind'
									ELSE 'purge'
								END,
							updated_at = clock_timestamp()
						WHERE id = ${input.memberId}
						  AND session_id = ${input.sessionId}
						  AND launch_operation_id = ${input.operationId}
						  AND status = 'starting'
							RETURNING launch_cleanup_action
						`),
        );
        return marked.length > 0
          ? { status: "cleanup", action: marked[0].launch_cleanup_action }
          : { status: "stale" };
      };
      const candidates = rows<{
        team_id: string;
        workflow_execution_id: string | null;
        lead_session_id: string;
        project_id: string;
        team_status: string;
        status: string;
        launch_cleanup_requested_at: Date | null;
        launch_cleanup_action: TeamMemberLaunchCleanupAction | null;
        launch_dispatch_recipe: unknown;
      }>(
        await tx.execute(sql`
					SELECT member.team_id, team.workflow_execution_id, team.lead_session_id,
					       team.project_id,
					       team.status AS team_status,
					       member.status, member.launch_cleanup_requested_at,
					       member.launch_cleanup_action,
					       member.launch_dispatch_recipe
				FROM team_members AS member
				JOIN teams AS team ON team.id = member.team_id
				WHERE member.id = ${input.memberId}
				  AND member.session_id = ${input.sessionId}
				  AND member.launch_operation_id = ${input.operationId}
				  AND member.role <> 'lead'
				LIMIT 1
			`),
      );
      const candidate = candidates[0];
      if (!candidate) return { status: "stale" } as const;
      const dispatchRecipe = parseDispatchRecipe(
        candidate.launch_dispatch_recipe,
      );
      if (
        !dispatchRecipe ||
        dispatchRecipe.teamId !== candidate.team_id ||
        dispatchRecipe.request.sessionId !== input.sessionId ||
        dispatchRecipe.principal.sessionId !== candidate.lead_session_id ||
        dispatchRecipe.principal.projectId !== candidate.project_id
      ) {
        return markForCleanup("unwind");
      }
      if (candidate.status !== "starting" && candidate.status !== "working") {
        return { status: "stale" } as const;
      }
      let launchAuthorityActive = candidate.team_status === "active";

      // Match lifecycle/start-authority ordering. Each SELECT gets a fresh
      // READ COMMITTED snapshot after any earlier lock wait, so a stop that
      // wins first is observed before membership can be promoted.
      if (candidate.workflow_execution_id) {
        const workflows = rows<{ id: string }>(
          await tx.execute(sql`
					SELECT execution.id
					FROM workflow_executions AS execution
						WHERE execution.id = ${candidate.workflow_execution_id}
						  AND execution.user_id = ${dispatchRecipe.principal.userId}
						  AND execution.project_id = ${dispatchRecipe.principal.projectId}
					  AND execution.status IN ('pending', 'running')
					  AND execution.stop_requested_at IS NULL
					  AND execution.completed_at IS NULL
					FOR UPDATE OF execution
				`),
        );
        if (workflows.length === 0) launchAuthorityActive = false;
      }

      const leads = rows<{ id: string }>(
        await tx.execute(sql`
				SELECT lead.id
				FROM sessions AS lead
					WHERE lead.id = ${candidate.lead_session_id}
					  AND lead.user_id = ${dispatchRecipe.principal.userId}
					  AND lead.project_id = ${dispatchRecipe.principal.projectId}
				  AND lead.status IN ('rescheduling', 'running', 'idle')
				  AND lead.stop_requested_at IS NULL
				  AND lead.completed_at IS NULL
				FOR UPDATE OF lead
			`),
      );
      if (leads.length === 0) launchAuthorityActive = false;

      const children = rows<LaunchChildRow>(
        await tx.execute(sql`
							SELECT child.id, child.parent_execution_id,
							       child.workflow_execution_id, child.status,
							       child.agent_id, child.agent_version,
							       child.user_id, child.project_id,
							       child.stop_requested_at, child.completed_at,
							       child.dapr_instance_id, child.runtime_app_id,
							       child.runtime_provisioning_started_at
							FROM sessions AS child
							WHERE child.id = ${input.sessionId}
							FOR UPDATE OF child
						`),
      );
      const child = children[0] ?? null;
      const ownership: LaunchOwnership = {
        teamId: candidate.team_id,
        workflowExecutionId: candidate.workflow_execution_id,
        leadSessionId: candidate.lead_session_id,
        projectId: candidate.project_id,
      };
      const childIsOwned = childOwnedByLaunch(child, ownership, dispatchRecipe);
      const cleanupAction: TeamMemberLaunchCleanupAction = childIsOwned
        ? "purge"
        : "unwind";
      const currentRuntimeAppId = child?.runtime_app_id?.trim() || null;
      const currentDaprInstanceId = child?.dapr_instance_id?.trim() || null;
      const currentProvisioningStartedAt =
        child?.runtime_provisioning_started_at ?? null;
      const scannedGenerationMatches =
        (!Object.prototype.hasOwnProperty.call(input, "expectedRuntimeAppId") ||
          (input.expectedRuntimeAppId?.trim() || null) ===
            currentRuntimeAppId) &&
        (!Object.prototype.hasOwnProperty.call(
          input,
          "expectedDaprInstanceId",
        ) ||
          (input.expectedDaprInstanceId?.trim() || null) ===
            currentDaprInstanceId) &&
        (!Object.prototype.hasOwnProperty.call(
          input,
          "expectedRuntimeProvisioningStartedAt",
        ) ||
          sameTimestamp(
            input.expectedRuntimeProvisioningStartedAt ?? null,
            currentProvisioningStartedAt,
          ));
      const fenceChildPurge = async (): Promise<boolean> => {
        if (!child || !childIsOwned || !scannedGenerationMatches) {
          return false;
        }
        const fenced = rows<{ id: string }>(
          await tx.execute(sql`
									WITH stop_intent AS (
										SELECT clock_timestamp() AS requested_at
									)
									UPDATE sessions
									SET stop_requested_at = COALESCE(
											stop_requested_at,
											stop_intent.requested_at
										),
										stop_requested_mode = CASE
											WHEN stop_requested_at IS NULL THEN 'purge'
											WHEN stop_requested_mode = 'reset' THEN 'reset'
											ELSE 'purge'
										END,
										updated_at = CASE
											WHEN stop_requested_at IS NULL THEN stop_intent.requested_at
											ELSE updated_at
										END
									FROM stop_intent
									WHERE id = ${input.sessionId}
									  AND parent_execution_id = ${ownership.leadSessionId}
									  AND workflow_execution_id IS NOT DISTINCT FROM ${ownership.workflowExecutionId}
									  AND agent_id = ${dispatchRecipe.request.peerAgentId}
									  AND agent_version = ${dispatchRecipe.request.peerAgentVersion}
									  AND user_id = ${dispatchRecipe.principal.userId}
									  AND project_id = ${dispatchRecipe.principal.projectId}
									  AND dapr_instance_id IS NOT DISTINCT FROM ${currentDaprInstanceId}
									  AND runtime_app_id IS NOT DISTINCT FROM ${currentRuntimeAppId}
									  AND runtime_provisioning_started_at IS NOT DISTINCT FROM ${
											currentProvisioningStartedAt == null
												? null
												: toPostgresTimestampParam(
														currentProvisioningStartedAt,
													)
										}
									RETURNING id
								`),
        );
        return fenced.length > 0;
      };
      const prepareCleanup = async (
        action: TeamMemberLaunchCleanupAction,
      ): Promise<TeamMemberLaunchCleanupAction | null> => {
        if (action === "unwind") return "unwind";
        if (!scannedGenerationMatches) return null;
        return (await fenceChildPurge()) ? "purge" : "unwind";
      };
      const members = rows<{
        id: string;
        status: string;
        launch_cleanup_requested_at: Date | null;
        launch_cleanup_action: TeamMemberLaunchCleanupAction | null;
      }>(
        await tx.execute(sql`
					SELECT member.id, member.status, member.launch_cleanup_requested_at,
					       member.launch_cleanup_action
				FROM team_members AS member
				JOIN teams AS team ON team.id = member.team_id
				WHERE member.id = ${input.memberId}
				  AND member.team_id = ${candidate.team_id}
				  AND member.session_id = ${input.sessionId}
				  AND member.launch_operation_id = ${input.operationId}
				  AND member.role <> 'lead'
					  AND team.lead_session_id = ${candidate.lead_session_id}
				  AND team.workflow_execution_id IS NOT DISTINCT FROM ${candidate.workflow_execution_id}
				FOR UPDATE OF member
			`),
      );
      const member = members[0];
      if (!member) return { status: "stale" } as const;
      if (member.status !== "starting" && member.status !== "working") {
        return { status: "stale" } as const;
      }
      const effectiveCleanupAction: TeamMemberLaunchCleanupAction =
        member.launch_cleanup_action === "unwind" ? "unwind" : cleanupAction;
      if (!launchAuthorityActive) {
        const prepared = await prepareCleanup(effectiveCleanupAction);
        return prepared
          ? markForCleanup(prepared)
          : ({ status: "stale" } as const);
      }
      if (member.status === "starting" && member.launch_cleanup_requested_at) {
        const prepared = await prepareCleanup(effectiveCleanupAction);
        if (!prepared) return { status: "stale" } as const;
        if (prepared === "unwind") {
          return markForCleanup("unwind");
        }
        return {
          status: "cleanup",
          // The exact child generation now carries the durable purge intent,
          // so its global id cannot be reused before lifecycle resolves it.
          action: prepared,
        } as const;
      }

      if (!scannedGenerationMatches) {
        // A new generation appeared after the scan. Let the next bounded scan
        // prove that generation instead of touching it from a stale snapshot.
        return { status: "stale" } as const;
      }

      const childLineageActive = Boolean(
        childOwnedByLaunch(child, ownership, dispatchRecipe) &&
        child &&
        ["rescheduling", "running", "idle"].includes(child.status) &&
        child.stop_requested_at == null &&
        child.completed_at == null,
      );
      if (childLineageActive && child?.runtime_provisioning_started_at) {
        return { status: "pending" } as const;
      }
      const publishedExactGeneration = Boolean(
        childLineageActive &&
        currentRuntimeAppId &&
        currentDaprInstanceId &&
        child.runtime_provisioning_started_at == null,
      );
      if (!publishedExactGeneration) {
        const prepared = await prepareCleanup(effectiveCleanupAction);
        return prepared
          ? markForCleanup(prepared)
          : ({ status: "stale" } as const);
      }
      if (member.status === "working") {
        return { status: "promoted" } as const;
      }

      const promoted = rows<{ id: string }>(
        await tx.execute(sql`
				UPDATE team_members
				SET status = 'working', launch_completed_at = clock_timestamp(),
				    updated_at = clock_timestamp()
				WHERE id = ${input.memberId}
				  AND session_id = ${input.sessionId}
				  AND launch_operation_id = ${input.operationId}
				  AND launch_cleanup_requested_at IS NULL
				  AND status = 'starting'
				RETURNING id
			`),
      );
      return promoted.length > 0
        ? ({ status: "promoted" } as const)
        : ({ status: "stale" } as const);
    });
  }

  async cancelMemberSpawn(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
			DELETE FROM team_members
			WHERE id = ${input.memberId}
			  AND session_id = ${input.sessionId}
			  AND launch_operation_id = ${input.operationId}
			  AND launch_kind = 'spawn'
			  AND role <> 'lead'
			  AND status = 'starting'
			RETURNING id
		`);
    return rows<{ id: string }>(r).length > 0;
  }

  async cancelMemberRevival(
    input: TeamMemberRevivalReservationInput & { operationId: string },
  ): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members
			SET session_id = ${input.previousSessionId},
				status = ${input.previousStatus},
				launch_operation_id = NULL,
				launch_kind = NULL,
				launch_started_at = NULL,
				launch_completed_at = NULL,
				launch_cleanup_requested_at = NULL,
				launch_cleanup_action = NULL,
				launch_previous_session_id = NULL,
				launch_previous_status = NULL,
				launch_dispatch_recipe = NULL,
				updated_at = now()
			WHERE id = ${input.memberId}
			  AND team_id = ${input.teamId}
			  AND session_id = ${input.sessionId}
			  AND launch_operation_id = ${input.operationId}
			  AND launch_kind = 'revival'
			  AND launch_previous_session_id = ${input.previousSessionId}
			  AND launch_previous_status = ${input.previousStatus}
			  AND role <> 'lead'
			  AND status = 'starting'
			RETURNING id
		`);
    return rows<{ id: string }>(r).length > 0;
  }

  async listStaleMemberLaunches(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<StaleTeamMemberLaunch[]> {
    const r = await this.db.execute<{
      member_id: string;
      team_id: string;
      session_id: string;
      operation_id: string;
      kind: "spawn" | "revival";
      started_at: Date;
      cleanup_requested_at: Date | null;
      cleanup_action: TeamMemberLaunchCleanupAction | null;
      previous_session_id: string | null;
      previous_status: TerminalTeamMemberStatus | null;
      runtime_app_id: string | null;
      dapr_instance_id: string | null;
      runtime_provisioning_started_at: Date | null;
    }>(sql`
			SELECT member.id AS member_id, member.team_id, member.session_id,
			       member.launch_operation_id AS operation_id,
			       member.launch_kind AS kind,
				       member.launch_started_at AS started_at,
				       member.launch_cleanup_requested_at AS cleanup_requested_at,
				       member.launch_cleanup_action AS cleanup_action,
			       member.launch_previous_session_id AS previous_session_id,
			       member.launch_previous_status AS previous_status,
			       child.runtime_app_id, child.dapr_instance_id,
			       child.runtime_provisioning_started_at
			FROM team_members AS member
			LEFT JOIN sessions AS child ON child.id = member.session_id
			WHERE member.status = 'starting'
			  AND member.launch_operation_id IS NOT NULL
			  AND member.launch_kind IN ('spawn', 'revival')
			  AND member.launch_started_at <= ${toPostgresTimestampParam(input.staleBefore)}
			ORDER BY member.launch_started_at ASC, member.id ASC
			LIMIT ${Math.max(1, Math.min(Math.trunc(input.limit || 20), 200))}
		`);
    return rows<{
      member_id: string;
      team_id: string;
      session_id: string;
      operation_id: string;
      kind: "spawn" | "revival";
      started_at: Date;
      cleanup_requested_at: Date | null;
      cleanup_action: TeamMemberLaunchCleanupAction | null;
      previous_session_id: string | null;
      previous_status: TerminalTeamMemberStatus | null;
      runtime_app_id: string | null;
      dapr_instance_id: string | null;
      runtime_provisioning_started_at: Date | null;
    }>(r).map((row) => ({
      memberId: row.member_id,
      teamId: row.team_id,
      sessionId: row.session_id,
      operationId: row.operation_id,
      kind: row.kind,
      startedAt: row.started_at,
      cleanupRequestedAt: row.cleanup_requested_at,
      cleanupAction: row.cleanup_action,
      previousSessionId: row.previous_session_id,
      previousStatus: row.previous_status,
      runtimeAppId: row.runtime_app_id?.trim() || null,
      daprInstanceId: row.dapr_instance_id?.trim() || null,
      runtimeProvisioningStartedAt: row.runtime_provisioning_started_at ?? null,
    }));
  }

  reconcileStaleMemberLaunch(
    input: StaleTeamMemberLaunch,
  ): Promise<TeamMemberLaunchReconcileResult> {
    return this.resolveStartingMemberLaunch({
      memberId: input.memberId,
      sessionId: input.sessionId,
      operationId: input.operationId,
      expectedRuntimeAppId: input.runtimeAppId,
      expectedDaprInstanceId: input.daprInstanceId,
      expectedRuntimeProvisioningStartedAt: input.runtimeProvisioningStartedAt,
    });
  }

  async completeMemberLaunchCleanup(input: {
    memberId: string;
    sessionId: string;
    operationId: string;
  }): Promise<boolean> {
    const deleted = await this.db.execute<{ id: string }>(sql`
			DELETE FROM team_members
			WHERE id = ${input.memberId}
			  AND session_id = ${input.sessionId}
			  AND launch_operation_id = ${input.operationId}
				  AND launch_kind = 'spawn'
				  AND launch_cleanup_requested_at IS NOT NULL
				  AND status = 'starting'
				  AND (
					launch_cleanup_action = 'unwind'
					OR (
					  launch_cleanup_action = 'purge'
					  AND NOT EXISTS (
						SELECT 1
						FROM sessions AS child
						WHERE child.id = team_members.session_id
						  AND child.status <> 'terminated'
						  AND child.completed_at IS NULL
					  )
					)
				  )
				RETURNING id
		`);
    if (rows<{ id: string }>(deleted).length > 0) return true;

    const restored = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members
			SET session_id = launch_previous_session_id,
			    status = launch_previous_status,
			    launch_operation_id = NULL,
			    launch_kind = NULL,
			    launch_started_at = NULL,
			    launch_completed_at = NULL,
			    launch_cleanup_requested_at = NULL,
			    launch_cleanup_action = NULL,
			    launch_previous_session_id = NULL,
			    launch_previous_status = NULL,
			    launch_dispatch_recipe = NULL,
			    updated_at = clock_timestamp()
			WHERE id = ${input.memberId}
			  AND session_id = ${input.sessionId}
			  AND launch_operation_id = ${input.operationId}
			  AND launch_kind = 'revival'
			  AND launch_previous_session_id IS NOT NULL
				  AND launch_previous_status IN ('failed', 'shutdown')
				  AND launch_cleanup_requested_at IS NOT NULL
				  AND status = 'starting'
				  AND (
					launch_cleanup_action = 'unwind'
					OR (
					  launch_cleanup_action = 'purge'
					  AND NOT EXISTS (
						SELECT 1
						FROM sessions AS child
						WHERE child.id = team_members.session_id
						  AND child.status <> 'terminated'
						  AND child.completed_at IS NULL
					  )
					)
				  )
				RETURNING id
		`);
    return rows<{ id: string }>(restored).length > 0;
  }

	async listMembers(teamId: string): Promise<TeamMemberRow[]> {
		const r = await this.db.execute<TeamMemberRow>(sql`
			SELECT * FROM team_members WHERE team_id = ${teamId} ORDER BY joined_at ASC
		`);
		return rows<TeamMemberRow>(r);
	}

	async getTeam(teamId: string): Promise<TeamRow | null> {
		const r = await this.db.execute<TeamRow>(sql`
			SELECT id, name, status, lead_session_id, token_budget FROM teams WHERE id = ${teamId}
		`);
		return rows<TeamRow>(r)[0] ?? null;
	}

  async getMemberByName(
    teamId: string,
    name: string,
  ): Promise<TeamMemberRow | null> {
		const r = await this.db.execute<TeamMemberRow>(sql`
			SELECT * FROM team_members WHERE team_id = ${teamId} AND name = ${name} LIMIT 1
		`);
		return rows<TeamMemberRow>(r)[0] ?? null;
	}

	async getMemberBySession(sessionId: string): Promise<TeamMemberRow | null> {
		const r = await this.db.execute<TeamMemberRow>(sql`
			SELECT * FROM team_members WHERE session_id = ${sessionId} LIMIT 1
		`);
		return rows<TeamMemberRow>(r)[0] ?? null;
	}

	/** All members currently idle OR suspended (across active teams) — the tick's
	 * lost-idle/nudge set. Nudging a SUSPENDED member is deliberate: the nudge
	 * publishes to the delivery topic, and team-delivery wakes the sandbox —
	 * "wake when claimable work appears" falls out of the same path. */
	async listIdleMembers(): Promise<TeamMemberRow[]> {
		const r = await this.db.execute<TeamMemberRow>(sql`
			SELECT m.* FROM team_members m
			JOIN sessions s ON s.id = m.session_id
			WHERE m.status IN ('idle', 'suspended')
			  AND s.stop_requested_at IS NULL
			  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
		`);
		return rows<TeamMemberRow>(r);
	}

  async transitionActiveMemberStatus(input: {
    sessionId: string;
    expectedStatuses: readonly ActiveTeamMemberStatus[];
    status: ActiveTeamMemberStatus;
  }): Promise<boolean> {
    if (input.expectedStatuses.length === 0) return false;
    const expectedStatuses = sql.join(
      input.expectedStatuses.map((status) => sql`${status}`),
      sql`, `,
    );
    const r = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members AS m
			SET status = ${input.status}, updated_at = now()
			FROM sessions AS s
			WHERE m.session_id = ${input.sessionId}
			  AND s.id = m.session_id
			  AND m.role <> 'lead'
			  AND m.status NOT IN ('failed', 'shutdown')
			  AND m.status IN (${expectedStatuses})
			  AND s.stop_requested_at IS NULL
			  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
			RETURNING m.id
		`);
    return rows<{ id: string }>(r).length > 0;
  }

  async transitionMemberToFailed(sessionId: string): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members AS m
			SET status = 'failed', updated_at = now()
			FROM sessions AS s
			WHERE m.session_id = ${sessionId}
			  AND s.id = m.session_id
			  AND m.role <> 'lead'
			  AND m.status NOT IN ('failed', 'shutdown')
			  AND s.stop_requested_at IS NULL
			RETURNING m.id
		`);
    return rows<{ id: string }>(r).length > 0;
  }

  async finalizeMemberShutdown(input: {
    memberId: string;
    sessionId: string;
  }): Promise<TeamMemberShutdownFinalizeResult> {
    const r = await this.db.execute<{
      result: TeamMemberShutdownFinalizeResult;
    }>(sql`
			WITH updated AS (
				UPDATE team_members
				SET status = 'shutdown', updated_at = now()
				WHERE id = ${input.memberId}
				  AND session_id = ${input.sessionId}
				  AND role <> 'lead'
				  AND status NOT IN ('failed', 'shutdown')
				RETURNING id
			), current_member AS (
				SELECT session_id, status
				FROM team_members
				WHERE id = ${input.memberId}
			)
			SELECT CASE
				WHEN EXISTS (SELECT 1 FROM updated) THEN 'updated'
				WHEN EXISTS (
					SELECT 1 FROM current_member
					WHERE session_id = ${input.sessionId}
					  AND status IN ('failed', 'shutdown')
				) THEN 'already_terminal'
				ELSE 'stale'
			END AS result
		`);
    return (
      rows<{ result: TeamMemberShutdownFinalizeResult }>(r)[0]?.result ??
      "stale"
    );
	}

	/** Tokens consumed by the whole team: sum agent.llm_usage input+output over
	 * every member session. Same source as the run metrics aggregate (the
	 * sessions.usage rollup is runtime-dependent; llm_usage events are not). */
	async getTeamTokensUsed(teamId: string): Promise<number> {
		const r = await this.db.execute<{ used: string | number }>(sql`
			SELECT coalesce(sum(
				coalesce((e.data->>'input_tokens')::bigint, 0) +
				coalesce((e.data->>'output_tokens')::bigint, 0)
			), 0) AS used
			FROM session_events e
			JOIN team_members m ON m.session_id = e.session_id
			WHERE m.team_id = ${teamId} AND e.type = 'agent.llm_usage'
		`);
		return Number(rows<{ used: string | number }>(r)[0]?.used ?? 0);
	}

	async setMemberSession(input: {
		memberId: string;
    previousSessionId: string;
		sessionId: string;
		status?: TeamMemberStatus;
  }): Promise<boolean> {
    const status = input.status ?? "working";
    const r = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members AS member
			SET session_id = ${input.sessionId}, status = ${status}, updated_at = now()
			WHERE member.id = ${input.memberId}
			  AND member.role <> 'lead'
			  AND (
				  (member.session_id = ${input.previousSessionId} AND member.status IN ('failed', 'shutdown'))
				  OR (member.session_id = ${input.sessionId} AND member.status = ${status})
			  )
			  AND EXISTS (
				  SELECT 1
				  FROM sessions AS replacement
				  JOIN teams AS team ON team.id = member.team_id
				  JOIN sessions AS lead ON lead.id = team.lead_session_id
				  LEFT JOIN workflow_executions AS execution
					  ON execution.id = replacement.workflow_execution_id
				  WHERE replacement.id = ${input.sessionId}
					AND replacement.parent_execution_id = team.lead_session_id
					AND replacement.stop_requested_at IS NULL
					AND replacement.completed_at IS NULL
					AND replacement.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
					AND lead.stop_requested_at IS NULL
					AND lead.completed_at IS NULL
					AND lead.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
					AND (
						replacement.workflow_execution_id IS NULL
						OR (
							execution.id IS NOT NULL
							AND execution.stop_requested_at IS NULL
							AND execution.completed_at IS NULL
							AND execution.status NOT IN ('success', 'error', 'cancelled', 'canceled', 'completed', 'failed')
						)
					)
			  )
			RETURNING member.id
		`);
    return rows<{ id: string }>(r).length > 0;
	}

	async setMemberPlanApproved(sessionId: string): Promise<void> {
		await this.db.execute(sql`
			UPDATE team_members SET plan_mode_required = false, updated_at = now()
			WHERE session_id = ${sessionId}
		`);
	}

	// ── shared knowledge (OKF-shaped content layer) ───────────────────────────

  async upsertKnowledge(
    input: UpsertTeamKnowledgeInput,
  ): Promise<TeamKnowledgeRow> {
		const r = await this.db.execute<TeamKnowledgeRow>(sql`
			INSERT INTO team_knowledge
				(id, team_id, path, type, title, description, resource, tags, body, created_by_session_id)
			VALUES (
				${nanoid()}, ${input.teamId}, ${input.path}, ${input.type},
				${input.title ?? null}, ${input.description ?? null}, ${input.resource ?? null},
				${JSON.stringify(input.tags ?? [])}::jsonb, ${input.body},
				${input.createdBySessionId ?? null}
			)
			ON CONFLICT (team_id, path) DO UPDATE SET
				type = EXCLUDED.type,
				title = EXCLUDED.title,
				description = EXCLUDED.description,
				resource = EXCLUDED.resource,
				tags = EXCLUDED.tags,
				body = EXCLUDED.body,
				updated_at = now()
			RETURNING *
		`);
		return rows<TeamKnowledgeRow>(r)[0];
	}

	async listKnowledge(
		teamId: string,
		filter?: { type?: string },
	): Promise<TeamKnowledgeIndexEntry[]> {
		const r = filter?.type
			? await this.db.execute(sql`
					SELECT path, type, title, description, resource, tags, created_by_session_id, created_at, updated_at
					FROM team_knowledge WHERE team_id = ${teamId} AND type = ${filter.type}
					ORDER BY path ASC
				`)
			: await this.db.execute(sql`
					SELECT path, type, title, description, resource, tags, created_by_session_id, created_at, updated_at
					FROM team_knowledge WHERE team_id = ${teamId}
					ORDER BY path ASC
				`);
		return rows<TeamKnowledgeIndexEntry>(r);
	}

  async getKnowledge(
    teamId: string,
    path: string,
  ): Promise<TeamKnowledgeRow | null> {
		const r = await this.db.execute<TeamKnowledgeRow>(sql`
			SELECT * FROM team_knowledge WHERE team_id = ${teamId} AND path = ${path} LIMIT 1
		`);
		return rows<TeamKnowledgeRow>(r)[0] ?? null;
	}

	/** Event types that tell the "what is this member doing" story. Kept small
	 * so the LATERAL latest-per-member probe stays cheap. */
	private static readonly LIVE_EVENT_TYPES = [
		"agent.message",
		"agent.thinking",
		"agent.tool_use",
		"mcp.tool_call",
		"user.message",
		"session.status_idle",
		"session.status_running",
		"session.host_suspended",
		"session.host_woken",
		"session.error",
	] as const;

	async getTeamLiveActivity(input: {
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
	}> {
		const limit = Math.min(Math.max(input.streamLimit ?? 40, 1), 100);
		// Static literal list (values are compile-time constants) — portable
		// across postgres-js and PGlite without array-param binding differences.
		const typeList = sql.raw(
			PostgresTeamStore.LIVE_EVENT_TYPES.map((t) => `'${t}'`).join(", "),
		);
		const eventCols = sql`
			e.type AS event_type,
			coalesce(e.data->>'name', e.data->>'tool_name') AS tool_name,
			e.data->'input'->>'path' AS tool_path,
			e.data->>'origin' AS origin,
			e.data->>'fromAgent' AS from_agent,
			left(coalesce(e.data->'content'->0->>'text', e.data->>'preview', ''), 160) AS preview,
			e.created_at AS event_at
		`;
		const members = (await this.db.execute(sql`
			SELECT m.name, m.role, m.status, m.session_id, ev.*
			FROM team_members m
			LEFT JOIN LATERAL (
				SELECT ${eventCols}
				FROM session_events e
				WHERE e.session_id = m.session_id
				  AND e.type IN (${typeList})
				ORDER BY e.created_at DESC
				LIMIT 1
			) ev ON true
			WHERE m.team_id = ${input.teamId}
			ORDER BY m.joined_at ASC
		`)) as Array<{
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
		const stream = (await this.db.execute(sql`
			SELECT m.name, e.session_id, ${eventCols}
			FROM session_events e
			JOIN team_members m ON m.session_id = e.session_id
			WHERE m.team_id = ${input.teamId}
			  AND e.type IN (${typeList})
			ORDER BY e.created_at DESC
			LIMIT ${limit}
		`)) as Array<{
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
		return { members, stream };
	}

	/** Resolve an agent slug to its id within a project, for peer spawn. */
	async resolveAgentIdBySlug(
		projectId: string,
		slug: string,
	): Promise<{ id: string } | null> {
		const r = await this.db.execute<{ id: string }>(sql`
			SELECT id FROM agents
			WHERE project_id = ${projectId} AND slug = ${slug}
			LIMIT 1
		`);
		return rows<{ id: string }>(r)[0] ?? null;
	}

	// ── shared task list ────────────────────────────────────────────────────

	async listTeamTasks(teamId: string): Promise<TeamTaskListItem[]> {
		const r = await this.db.execute(sql`
			SELECT id, title, status, assignee_session_id, depends_on, updated_at,
			       completed_at, completion_note
			FROM team_tasks WHERE team_id = ${teamId} ORDER BY created_at ASC
		`);
		return rows<TeamTaskListItem>(r);
	}

	async createTask(input: CreateTeamTaskInput): Promise<TeamTaskRow> {
		const r = await this.db.execute<TeamTaskRow>(sql`
			INSERT INTO team_tasks
				(id, team_id, title, description, depends_on, created_by_session_id,
				 assignee_session_id, status)
			VALUES (
				${nanoid()}, ${input.teamId}, ${input.title}, ${input.description ?? null},
				${JSON.stringify(input.dependsOn ?? [])}::jsonb, ${input.createdBySessionId ?? null},
				${input.assigneeSessionId ?? null}, ${input.status ?? "pending"}
			)
			RETURNING *
		`);
		return rows<TeamTaskRow>(r)[0];
	}

	/**
	 * Atomically claim the oldest eligible task for `sessionId`. Eligible =
	 * pending, all depends_on completed, and (unassigned OR pre-assigned to the
	 * CALLER) — a task the lead pre-assigned via assignTo is claimable only by
	 * its designated member, and that member picks it up BEFORE any open task
	 * (role-affinity: your assigned work outranks the general queue). FOR UPDATE
	 * SKIP LOCKED lets N idle teammates claim concurrently without contending.
	 */
	async claimNextTask(input: {
		teamId: string;
		sessionId: string;
	}): Promise<TeamTaskRow | null> {
		const r = await this.db.execute<TeamTaskRow>(sql`
			UPDATE team_tasks
			SET status = 'in_progress', assignee_session_id = ${input.sessionId}, updated_at = now()
			WHERE id = (
				SELECT t.id FROM team_tasks t
				WHERE t.team_id = ${input.teamId}
				  AND t.status = 'pending'
				  AND (t.assignee_session_id IS NULL OR t.assignee_session_id = ${input.sessionId})
				  AND NOT EXISTS (
					SELECT 1 FROM jsonb_array_elements_text(t.depends_on) dep
					JOIN team_tasks d ON d.id = dep
					WHERE d.status <> 'completed'
				  )
				ORDER BY (t.assignee_session_id = ${input.sessionId}) DESC NULLS LAST, t.created_at
				FOR UPDATE SKIP LOCKED
				LIMIT 1
			)
			RETURNING *
		`);
		return rows<TeamTaskRow>(r)[0] ?? null;
	}

	async countClaimableTasks(teamId: string): Promise<number> {
		// Pending + deps met, regardless of pre-assignment: a pre-assigned pending
		// task is claimable by SOMEONE (its designee), so it still justifies a nudge.
		const r = await this.db.execute<{ n: number }>(sql`
			SELECT count(*)::int AS n FROM team_tasks t
			WHERE t.team_id = ${teamId}
			  AND t.status = 'pending'
			  AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements_text(t.depends_on) dep
				JOIN team_tasks d ON d.id = dep WHERE d.status <> 'completed'
			  )
		`);
		return Number(rows<{ n: number }>(r)[0]?.n ?? 0);
	}

	async completeTask(input: {
		teamId: string;
		taskId: string;
		note?: string | null;
	}): Promise<TeamTaskRow | null> {
		const r = await this.db.execute<TeamTaskRow>(sql`
			UPDATE team_tasks
			SET status = 'completed', completed_at = now(), updated_at = now(),
			    completion_note = coalesce(${input.note ?? null}, completion_note)
			WHERE team_id = ${input.teamId} AND id = ${input.taskId}
			RETURNING *
		`);
		return rows<TeamTaskRow>(r)[0] ?? null;
	}

	/** One-query snapshot for the wake-on-deliver decision (team-delivery.ts). */
	async getSessionDeliveryState(sessionId: string): Promise<{
		status: string;
    stopRequested: boolean;
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
    runtimeDesiredRunning: boolean;
	} | null> {
		const r = (await this.db.execute(sql`
				SELECT s.status, s.stop_requested_at, s.dapr_instance_id, s.runtime_app_id,
				       s.runtime_sandbox_name,
				       COALESCE(m.runtime_desired_running, true) AS runtime_desired_running
				FROM sessions s
				LEFT JOIN team_members m ON m.session_id = s.id
				WHERE s.id = ${sessionId}
				LIMIT 1
		`)) as Array<{
			status: string;
      stop_requested_at: Date | null;
			dapr_instance_id: string | null;
			runtime_app_id: string | null;
			runtime_sandbox_name: string | null;
      runtime_desired_running: boolean;
		}>;
		const row = r[0];
		if (!row) return null;
		return {
			status: row.status,
      stopRequested: row.stop_requested_at != null,
      daprInstanceId: row.dapr_instance_id,
      runtimeAppId: row.runtime_app_id,
      runtimeSandboxName: row.runtime_sandbox_name,
      runtimeDesiredRunning: row.runtime_desired_running,
    };
  }

  async claimRuntimeOperation(input: {
    sessionId: string;
    operation: TeamRuntimeOperation;
    staleAfterSeconds: number;
  }): Promise<TeamRuntimeOperationLease | null> {
    const operationId = nanoid();
    const desiredRunning = input.operation === "delivery";
    const staleAfterSeconds = Math.min(
      Math.max(Math.trunc(input.staleAfterSeconds), 60),
      3600,
    );
    const r = (await this.db.execute(sql`
			WITH candidate AS (
				SELECT m.id, m.status AS member_status
				FROM team_members m
				JOIN sessions s ON s.id = m.session_id
				WHERE m.session_id = ${input.sessionId}
				  AND m.status NOT IN ('failed', 'shutdown')
				  AND s.stop_requested_at IS NULL
				  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
				  AND s.dapr_instance_id IS NOT NULL
					  AND (
						m.runtime_operation_id IS NULL
						OR (
							m.runtime_operation_started_at < clock_timestamp() - make_interval(secs => ${staleAfterSeconds})
							AND (
								m.runtime_operation = ${input.operation}
								OR (
									${input.operation} = 'delivery'
									AND EXISTS (
										SELECT 1
										FROM session_events pending
										WHERE pending.session_id = m.session_id
										  AND pending.type = 'user.message'
										  AND pending.processed_at IS NULL
										  AND pending.data->>'origin' IN ('teammate-message', 'team-broadcast', 'team-idle', 'team-error')
									)
								)
								OR ${input.operation} = 'suspend'
							)
						)
					  )
				  AND (
					${input.operation} <> 'suspend'
					OR (
						m.role <> 'lead'
						AND m.status = 'idle'
						AND NOT EXISTS (
							SELECT 1
							FROM session_events e
							WHERE e.session_id = m.session_id
							  AND e.type = 'user.message'
							  AND e.processed_at IS NULL
							  AND e.data->>'origin' IN ('teammate-message', 'team-broadcast', 'team-idle', 'team-error')
						)
					)
				  )
				FOR UPDATE OF m
			), claimed AS (
				UPDATE team_members m
				SET runtime_operation_id = ${operationId},
				    runtime_operation = ${input.operation},
				    runtime_operation_started_at = clock_timestamp(),
				    runtime_desired_running = ${desiredRunning}
				FROM candidate c
				WHERE m.id = c.id
				RETURNING m.session_id, m.runtime_operation_id, m.runtime_operation,
				          m.runtime_operation_started_at, m.runtime_desired_running,
				          c.member_status
			)
			SELECT c.runtime_operation_id, c.runtime_operation,
			       c.runtime_operation_started_at::text AS started_at,
			       c.runtime_desired_running, c.member_status,
			       s.dapr_instance_id, s.runtime_app_id, s.runtime_sandbox_name
			FROM claimed c
			JOIN sessions s ON s.id = c.session_id
		`)) as Array<{
      runtime_operation_id: string;
      runtime_operation: TeamRuntimeOperation;
      started_at: string;
      runtime_desired_running: boolean;
      member_status: string;
      dapr_instance_id: string;
      runtime_app_id: string | null;
      runtime_sandbox_name: string | null;
    }>;
    const row = r[0];
    if (!row) return null;
    return {
      operationId: row.runtime_operation_id,
      operation: row.runtime_operation,
      desiredRunning: row.runtime_desired_running,
      startedAt: row.started_at,
      memberStatus: row.member_status,
			daprInstanceId: row.dapr_instance_id,
			runtimeAppId: row.runtime_app_id,
			runtimeSandboxName: row.runtime_sandbox_name,
		};
	}

  async verifyRuntimeOperation(input: {
    sessionId: string;
    operationId: string;
    operation: TeamRuntimeOperation;
    desiredRunning: boolean;
  }): Promise<boolean> {
    const r = await this.db.execute<{ id: string }>(sql`
			SELECT m.id
			FROM team_members m
			JOIN sessions s ON s.id = m.session_id
			WHERE m.session_id = ${input.sessionId}
			  AND m.runtime_operation_id = ${input.operationId}
			  AND m.runtime_operation = ${input.operation}
			  AND m.runtime_desired_running = ${input.desiredRunning}
			  AND m.status NOT IN ('failed', 'shutdown')
			  AND s.stop_requested_at IS NULL
			  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
			LIMIT 1
		`);
    return rows<{ id: string }>(r).length > 0;
  }

  async finishRuntimeOperation(input: {
    sessionId: string;
    operationId: string;
    operation: TeamRuntimeOperation;
    memberStatus?: ActiveTeamMemberStatus;
    desiredRunning?: boolean;
  }): Promise<boolean> {
    const status = input.memberStatus ?? null;
    const desiredRunning = input.desiredRunning ?? null;
    const r = await this.db.execute<{ id: string }>(sql`
			UPDATE team_members AS m
			SET status = CASE
					WHEN ${status}::text IS NOT NULL
					  AND m.status NOT IN ('failed', 'shutdown')
					  AND s.stop_requested_at IS NULL
					  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
					THEN ${status}::text
					ELSE m.status
				END,
			    updated_at = CASE WHEN ${status}::text IS NOT NULL THEN clock_timestamp() ELSE m.updated_at END,
			    runtime_desired_running = CASE
					WHEN ${desiredRunning}::boolean IS NOT NULL
					  AND m.status NOT IN ('failed', 'shutdown')
					  AND s.stop_requested_at IS NULL
					  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
					THEN ${desiredRunning}::boolean
					ELSE m.runtime_desired_running
				END,
			    runtime_operation_id = NULL,
			    runtime_operation = NULL,
			    runtime_operation_started_at = NULL
			FROM sessions AS s
			WHERE m.session_id = ${input.sessionId}
			  AND s.id = m.session_id
			  AND m.runtime_operation_id = ${input.operationId}
			  AND m.runtime_operation = ${input.operation}
			RETURNING m.id
		`);
    return rows<{ id: string }>(r).length > 0;
  }

	/**
	 * Teammates idle past the silence threshold — the suspend tick's candidates.
	 * Silence is measured on sessions.last_event_at (the throttled liveness stamp
	 * the reconciler trusts), falling back to the member's own updated_at. Only
	 * members the driver marked 'idle' qualify (never the lead, never terminal
	 * sessions, never sessions that were never spawned).
	 */
	async listSuspendCandidates(input: { idleSeconds: number }): Promise<
		Array<{
			team_id: string;
			session_id: string;
			name: string;
			runtime_sandbox_name: string | null;
			last_event_at: string | null;
			updated_at: string;
			idle_seconds: number;
		}>
	> {
		const r = (await this.db.execute(sql`
			SELECT m.team_id, m.session_id, m.name, m.updated_at,
			       s.runtime_sandbox_name, s.last_event_at,
			       EXTRACT(EPOCH FROM (now() - COALESCE(s.last_event_at, m.updated_at)))::int AS idle_seconds
			FROM team_members m
			JOIN sessions s ON s.id = m.session_id
			WHERE m.status = 'idle'
			  AND m.role <> 'lead'
			  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
			  AND s.stop_requested_at IS NULL
			  AND s.dapr_instance_id IS NOT NULL
			  AND COALESCE(s.last_event_at, m.updated_at) < now() - make_interval(secs => ${input.idleSeconds})
		`)) as Array<{
			team_id: string;
			session_id: string;
			name: string;
			runtime_sandbox_name: string | null;
			last_event_at: string | null;
			updated_at: string;
			idle_seconds: number;
		}>;
		return r;
	}

	/**
   * Runtime-backed team sessions holding unraised team-origin messages older than the
	 * threshold — the delivery sweeper's re-publish set. The one lost delivery we
	 * observed on dev was acked by the pubsub hop with zero redelivery, so the
	 * tick re-publishes a trigger for any stranded mailbox; the atomic claim in
	 * team-delivery makes duplicate triggers harmless.
	 */
	async listSessionsWithStrandedTeamMessages(input: {
		olderThanSeconds: number;
	}): Promise<Array<{ session_id: string; stranded: number }>> {
		const r = (await this.db.execute(sql`
			SELECT e.session_id, count(*)::int AS stranded
			FROM session_events e
			JOIN team_members m ON m.session_id = e.session_id
			JOIN sessions s ON s.id = e.session_id
			WHERE e.type = 'user.message'
			  AND e.processed_at IS NULL
			  AND e.data->>'origin' IN ('teammate-message', 'team-broadcast', 'team-idle', 'team-error')
			  AND e.created_at < now() - make_interval(secs => ${input.olderThanSeconds})
			  AND s.dapr_instance_id IS NOT NULL
			  AND s.stop_requested_at IS NULL
			  AND s.status NOT IN ('terminated', 'completed', 'failed', 'canceled', 'cancelled', 'error', 'crashed')
			GROUP BY e.session_id
		`)) as Array<{ session_id: string; stranded: number }>;
		return r;
	}

	/**
	 * Recent team message traffic, newest first. Recipient-side rows: every
	 * team-origin user.message lands on the RECIPIENT's session_events with the
	 * sender in data.fromAgent, so joining team_members on the recipient session
	 * resolves both ends (the lead is a member row named 'lead', so member→lead
	 * sends resolve too). Feeds the TeamPulse message pulses + activity feed.
	 */
	async listRecentTeamMessages(input: {
		teamId: string;
		limit?: number;
	}): Promise<
		Array<{
			ts: string;
			from_name: string | null;
			to_session_id: string;
			to_name: string | null;
			kind: string;
			preview: string | null;
		}>
	> {
		const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
		const r = (await this.db.execute(sql`
			SELECT e.created_at                                  AS ts,
			       e.data->>'fromAgent'                          AS from_name,
			       e.session_id                                  AS to_session_id,
			       m.name                                        AS to_name,
			       e.data->>'origin'                             AS kind,
			       left(e.data->'content'->0->>'text', 140)      AS preview
			FROM session_events e
			JOIN team_members m ON m.session_id = e.session_id
			WHERE m.team_id = ${input.teamId}
			  AND e.type = 'user.message'
			  AND e.data->>'origin' IN ('teammate-message', 'team-broadcast', 'team-idle', 'team-error')
			ORDER BY e.created_at DESC
			LIMIT ${limit}
		`)) as Array<{
			ts: string;
			from_name: string | null;
			to_session_id: string;
			to_name: string | null;
			kind: string;
			preview: string | null;
		}>;
		return r;
	}

	// ── script-authored teams ("the script is the lead") ─────────────────────

	async getExecutionContext(
		executionId: string,
	): Promise<{ userId: string; projectId: string | null } | null> {
		const r = (await this.db.execute(sql`
			SELECT user_id, project_id FROM workflow_executions WHERE id = ${executionId} LIMIT 1
		`)) as Array<{ user_id: string; project_id: string | null }>;
		const row = r[0];
		if (!row) return null;
		return { userId: row.user_id, projectId: row.project_id };
	}

	/**
	 * Idempotent lead-anchor provisioning for a script team. Two inserts, both
	 * ON CONFLICT DO NOTHING:
	 *   1. the synthetic global agent `script-team-lead` (archived, disabled —
	 *      exists only to satisfy sessions.agent_id's NOT NULL FK; slug is
	 *      globally unique so one row serves every project),
	 *   2. the anchor sessions row (status idle, no runtime, stamped with the
	 *      script's execution so it rolls up under the run).
	 */
	async ensureScriptLeadSession(input: {
		sessionId: string;
		userId: string;
		projectId: string | null;
		executionId: string;
		title?: string;
	}): Promise<void> {
		await this.db.execute(sql`
			INSERT INTO agents (id, name, slug, model, is_default, is_enabled, is_archived, user_id)
			VALUES ('script-team-lead', 'Script Team Lead (synthetic)', 'script-team-lead',
			        '"none"'::jsonb, false, false, true, ${input.userId})
			ON CONFLICT DO NOTHING
		`);
		await this.db.execute(sql`
			INSERT INTO sessions (id, user_id, project_id, agent_id, status, title, workflow_execution_id)
			VALUES (${input.sessionId}, ${input.userId}, ${input.projectId},
			        'script-team-lead', 'idle',
			        ${input.title ?? "team:script-lead"}, ${input.executionId})
			ON CONFLICT (id) DO NOTHING
		`);
	}

	async getSessionExecutionId(sessionId: string): Promise<string | null> {
		const r = (await this.db.execute(sql`
			SELECT workflow_execution_id FROM sessions WHERE id = ${sessionId} LIMIT 1
		`)) as Array<{ workflow_execution_id: string | null }>;
		return r[0]?.workflow_execution_id ?? null;
	}

	// ── team-run container execution rollup ─────────────────────────────────

	async getTeamExecutionId(teamId: string): Promise<string | null> {
		const r = (await this.db.execute(
			sql`SELECT workflow_execution_id FROM teams WHERE id = ${teamId}`,
		)) as Array<{ workflow_execution_id: string | null }>;
		return r[0]?.workflow_execution_id ?? null;
	}

	async getSessionUserId(sessionId: string): Promise<string | null> {
		const r = (await this.db.execute(
			sql`SELECT user_id FROM sessions WHERE id = ${sessionId} LIMIT 1`,
		)) as Array<{ user_id: string | null }>;
		return r[0]?.user_id ?? null;
	}

	async getSessionProjectId(sessionId: string): Promise<string | null> {
		const r = (await this.db.execute(
			sql`SELECT project_id FROM sessions WHERE id = ${sessionId} LIMIT 1`,
		)) as Array<{ project_id: string | null }>;
		return r[0]?.project_id ?? null;
	}

  async ensureTeamRunWorkflow(
    projectId: string,
    userId: string,
  ): Promise<string> {
		const id = teamRunWorkflowId(projectId);
		await this.db.execute(sql`
			INSERT INTO workflows (id, name, user_id, nodes, edges, project_id, engine_type)
			VALUES (${id}, 'Agent Team Runs', ${userId}, '[]'::jsonb, '[]'::jsonb, ${projectId}, 'team-run')
			ON CONFLICT (id) DO NOTHING
		`);
		return id;
	}

	async setTeamExecutionId(teamId: string, executionId: string): Promise<void> {
		await this.db.execute(
			sql`UPDATE teams SET workflow_execution_id = ${executionId} WHERE id = ${teamId}`,
		);
	}

  async stampLeadSessionExecution(
    sessionId: string,
    executionId: string,
  ): Promise<void> {
		await this.db.execute(sql`
			UPDATE sessions SET workflow_execution_id = ${executionId}
			WHERE id = ${sessionId} AND workflow_execution_id IS NULL
		`);
	}

  async linkSessionToExecution(
    sessionId: string,
    executionId: string,
  ): Promise<void> {
		await this.db.execute(sql`
			UPDATE sessions SET workflow_execution_id = ${executionId} WHERE id = ${sessionId}
		`);
	}

	/**
	 * Recompute the container execution's status from team state and persist it, so
	 * the Fleet/runs list reflects the team live. No-op for teams without an
	 * execution row.
	 */
	async refreshTeamRunStatus(teamId: string): Promise<void> {
		const t = (await this.db.execute(
			sql`SELECT workflow_execution_id FROM teams WHERE id = ${teamId}`,
		)) as Array<{ workflow_execution_id: string | null }>;
		const execId = t[0]?.workflow_execution_id;
		if (!execId) return;

		// Only the SYNTHETIC team-run container execution is ours to reduce.
		// A script team ADOPTS the dynamic-script run's execution — its status
		// belongs to the pump (persist_results_to_db); writing here would fight
		// it (e.g. flip a running script to success when the team drains).
		const engine = (await this.db.execute(sql`
			SELECT execution_ir->>'engine' AS engine FROM workflow_executions WHERE id = ${execId}
		`)) as Array<{ engine: string | null }>;
		if ((engine[0]?.engine ?? null) !== "team-run") return;

		const counts = (await this.db.execute(sql`
			SELECT
				(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member') AS members,
				(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member' AND status = 'failed') AS failed,
				(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member' AND status IN ('working')) AS working,
				(SELECT count(*) FROM team_tasks WHERE team_id = ${teamId}) AS tasks,
				(SELECT count(*) FROM team_tasks WHERE team_id = ${teamId} AND status = 'completed') AS done
		`)) as Array<{
			members: number;
			failed: number;
			working: number;
			tasks: number;
			done: number;
		}>;
    const r = counts[0] ?? {
      members: 0,
      failed: 0,
      working: 0,
      tasks: 0,
      done: 0,
    };
		const tasks = Number(r.tasks);
		const done = Number(r.done);
		const working = Number(r.working);
		const members = Number(r.members);

		let status = "running";
		let phase = "running";
		if (Number(r.failed) > 0) {
			status = "error";
			phase = "failed";
    } else if (
      members > 0 &&
      working === 0 &&
      (tasks === 0 || done === tasks)
    ) {
			status = "success";
			phase = "complete";
		}
		const progress =
      tasks > 0
        ? Math.round((done / tasks) * 100)
        : status === "success"
          ? 100
          : 0;
		const terminal = status === "success" || status === "error";

		await this.db.execute(sql`
			UPDATE workflow_executions
			SET status = ${status}, phase = ${phase}, progress = ${progress},
			    completed_at = CASE WHEN ${terminal} THEN COALESCE(completed_at, now()) ELSE completed_at END
			WHERE id = ${execId}
		`);
	}
}
