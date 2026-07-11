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
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	AddMemberInput,
	CreateTeamTaskInput,
	EnsureTeamInput,
	TeamKnowledgeIndexEntry,
	TeamKnowledgeRow,
	TeamMemberRow,
	TeamMemberStatus,
	TeamRow,
	TeamStore,
	TeamTaskListItem,
	TeamTaskRow,
	UpsertTeamKnowledgeInput,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

function rows<T>(r: unknown): T[] {
	return r as T[];
}

/** One shared synthetic "Agent Team Runs" workflow per project (satisfies the
 * non-null workflow_executions.workflowId FK without a schema migration). */
function teamRunWorkflowId(projectId: string): string {
	return `team-run-wf-${projectId}`;
}

export class PostgresTeamStore implements TeamStore {
	constructor(private readonly getDatabase: () => Database = requirePostgresDb) {}

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
			ON CONFLICT (session_id) DO UPDATE SET status = 'working', updated_at = now()
			RETURNING *
		`);
		return rows<TeamMemberRow>(r)[0];
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

	async getMemberByName(teamId: string, name: string): Promise<TeamMemberRow | null> {
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
			SELECT * FROM team_members WHERE status IN ('idle', 'suspended')
		`);
		return rows<TeamMemberRow>(r);
	}

	async setMemberStatus(sessionId: string, status: TeamMemberStatus): Promise<void> {
		await this.db.execute(sql`
			UPDATE team_members SET status = ${status}, updated_at = now()
			WHERE session_id = ${sessionId}
		`);
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
		sessionId: string;
		status?: TeamMemberStatus;
	}): Promise<void> {
		await this.db.execute(sql`
			UPDATE team_members
			SET session_id = ${input.sessionId}, status = ${input.status ?? "working"}, updated_at = now()
			WHERE id = ${input.memberId}
		`);
	}

	async setMemberPlanApproved(sessionId: string): Promise<void> {
		await this.db.execute(sql`
			UPDATE team_members SET plan_mode_required = false, updated_at = now()
			WHERE session_id = ${sessionId}
		`);
	}

	// ── shared knowledge (OKF-shaped content layer) ───────────────────────────

	async upsertKnowledge(input: UpsertTeamKnowledgeInput): Promise<TeamKnowledgeRow> {
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

	async getKnowledge(teamId: string, path: string): Promise<TeamKnowledgeRow | null> {
		const r = await this.db.execute<TeamKnowledgeRow>(sql`
			SELECT * FROM team_knowledge WHERE team_id = ${teamId} AND path = ${path} LIMIT 1
		`);
		return rows<TeamKnowledgeRow>(r)[0] ?? null;
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
		daprInstanceId: string | null;
		runtimeAppId: string | null;
		runtimeSandboxName: string | null;
	} | null> {
		const r = (await this.db.execute(sql`
			SELECT status, dapr_instance_id, runtime_app_id, runtime_sandbox_name
			FROM sessions WHERE id = ${sessionId} LIMIT 1
		`)) as Array<{
			status: string;
			dapr_instance_id: string | null;
			runtime_app_id: string | null;
			runtime_sandbox_name: string | null;
		}>;
		const row = r[0];
		if (!row) return null;
		return {
			status: row.status,
			daprInstanceId: row.dapr_instance_id,
			runtimeAppId: row.runtime_app_id,
			runtimeSandboxName: row.runtime_sandbox_name,
		};
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
	 * Member sessions holding unraised team-origin messages older than the
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
			  AND m.role <> 'lead'
			  AND s.dapr_instance_id IS NOT NULL
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

	async ensureTeamRunWorkflow(projectId: string, userId: string): Promise<string> {
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

	async stampLeadSessionExecution(sessionId: string, executionId: string): Promise<void> {
		await this.db.execute(sql`
			UPDATE sessions SET workflow_execution_id = ${executionId}
			WHERE id = ${sessionId} AND workflow_execution_id IS NULL
		`);
	}

	async linkSessionToExecution(sessionId: string, executionId: string): Promise<void> {
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
		const r = counts[0] ?? { members: 0, failed: 0, working: 0, tasks: 0, done: 0 };
		const tasks = Number(r.tasks);
		const done = Number(r.done);
		const working = Number(r.working);
		const members = Number(r.members);

		let status = "running";
		let phase = "running";
		if (Number(r.failed) > 0) {
			status = "error";
			phase = "failed";
		} else if (members > 0 && working === 0 && (tasks === 0 || done === tasks)) {
			status = "success";
			phase = "complete";
		}
		const progress =
			tasks > 0 ? Math.round((done / tasks) * 100) : status === "success" ? 100 : 0;
		const terminal = status === "success" || status === "error";

		await this.db.execute(sql`
			UPDATE workflow_executions
			SET status = ${status}, phase = ${phase}, progress = ${progress},
			    completed_at = CASE WHEN ${terminal} THEN COALESCE(completed_at, now()) ELSE completed_at END
			WHERE id = ${execId}
		`);
	}
}
