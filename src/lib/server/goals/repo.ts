import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessions,
	sessionEvents,
	threadGoals,
	type ThreadGoalRow,
} from "$lib/server/db/schema";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

/**
 * Raw `db.execute(sql...)` rows come back with snake_case column names (no
 * drizzle field mapping), unlike the typed query builder. Map them to the
 * ThreadGoalRow shape so consumers (prompt rendering, sourceEventId derivation,
 * API responses) read real values instead of undefined.
 */
function mapGoalRow(row: Record<string, unknown> | undefined): ThreadGoalRow | null {
	if (!row) return null;
	const ts = (v: unknown): Date | null =>
		v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
	return {
		id: String(row.id),
		sessionId: String(row.session_id),
		goalId: String(row.goal_id),
		objective: String(row.objective),
		status: String(row.status),
		tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
		tokensUsed: Number(row.tokens_used ?? 0),
		timeUsedSeconds: Number(row.time_used_seconds ?? 0),
		iterations: Number(row.iterations ?? 0),
		maxIterations: Number(row.max_iterations ?? 0),
		acceptanceCriteria: (row.acceptance_criteria ?? null) as string[] | null,
		evidencePlan: (row.evidence_plan ?? null) as { commands?: string[] } | null,
		budgetSteeredAt: ts(row.budget_steered_at),
		lastContinuationAt: ts(row.last_continuation_at),
		stopReason: row.stop_reason === null ? null : String(row.stop_reason),
		workflowExecutionId:
			row.workflow_execution_id === null ? null : String(row.workflow_execution_id),
		createdAt: ts(row.created_at) ?? new Date(0),
		updatedAt: ts(row.updated_at) ?? new Date(0),
		completedAt: ts(row.completed_at),
	};
}

export type GoalStatus = "active" | "paused" | "budget_limited" | "complete";

/**
 * Minimum wall-clock spacing (seconds) between two continuation posts for the
 * same session. Real turns take far longer than this; the guard only collapses
 * a race between inline event hooks and explicit kickoff/stop-hook calls.
 */
export const CONTINUATION_MIN_SPACING_SECONDS = 2;

/** Most-recent goal row for a session (any status) — for get_goal / the UI. */
export async function getCurrentGoal(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb()
		.select()
		.from(threadGoals)
		.where(eq(threadGoals.sessionId, sessionId))
		.orderBy(desc(threadGoals.createdAt))
		.limit(1);
	return rows[0] ?? null;
}

/**
 * Most-recent goal row across a set of candidate sessions (a trace can resolve
 * to several owner sessions — the goal lives on the per-session AGENT session,
 * e.g. `…__durable__solve__run__0`). Prefer that agent session, then newest.
 * One indexed `session_id = ANY(...)` lookup. Used to assemble the goal-flow
 * view for the trace viewer.
 */
export async function getCurrentGoalForSessions(
	sessionIds: string[],
): Promise<ThreadGoalRow | null> {
	const ids = [...new Set(sessionIds.filter(Boolean))];
	if (ids.length === 0) return null;
	const rows = await requireDb()
		.select()
		.from(threadGoals)
		.where(inArray(threadGoals.sessionId, ids))
		.orderBy(
			sql`case when ${threadGoals.sessionId} like '%__durable__solve__run__%' then 0 else 1 end`,
			desc(threadGoals.createdAt),
		)
		.limit(1);
	return rows[0] ?? null;
}

/** Lean session-event row for goal-flow segmentation. */
export interface GoalFlowEventRow {
	sequence: number;
	type: string;
	data: Record<string, unknown>;
	createdAt: Date;
}

/** Session-event types the goal-flow segmentation reads (work + goal vocabulary). */
const GOAL_FLOW_EVENT_TYPES = [
	"user.message",
	"session.goal_rejected",
	"session.goal_completed",
	"session.status_idle",
	"agent.message",
	"agent.tool_use",
	"mcp.tool_call",
	"agent.llm_usage",
];

/**
 * Bounded, ordered read of the goal-flow-relevant session events for one
 * session (no full payloads beyond what segmentation needs). Indexed by
 * (session_id) + ordered by sequence; capped to keep the investigation cheap.
 */
export async function listGoalFlowEvents(
	sessionId: string,
	limit = 5000,
): Promise<GoalFlowEventRow[]> {
	const rows = await requireDb()
		.select({
			sequence: sessionEvents.sequence,
			type: sessionEvents.type,
			data: sessionEvents.data,
			createdAt: sessionEvents.createdAt,
		})
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				inArray(sessionEvents.type, GOAL_FLOW_EVENT_TYPES),
			),
		)
		.orderBy(asc(sessionEvents.sequence))
		.limit(limit);
	return rows.map((r) => ({
		sequence: r.sequence,
		type: r.type,
		data: (r.data ?? {}) as Record<string, unknown>,
		createdAt: r.createdAt,
	}));
}

/**
 * The goal the loop drives (active or budget_limited), if any. Prefer the
 * active row, then the newest — a session can hold an old budget_limited row
 * alongside a newly set active goal, and the driver must follow the new one.
 */
export async function getDrivableGoal(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb()
		.select()
		.from(threadGoals)
		.where(
			and(
				eq(threadGoals.sessionId, sessionId),
				sql`${threadGoals.status} in ('active','budget_limited')`,
			),
		)
		.orderBy(
			sql`case when ${threadGoals.status} = 'active' then 0 else 1 end`,
			desc(threadGoals.createdAt),
		)
		.limit(1);
	return rows[0] ?? null;
}

export interface CreateGoalInput {
	sessionId: string;
	objective: string;
	tokenBudget?: number | null;
	maxIterations?: number;
	workflowExecutionId?: string | null;
	/** Evaluator-gated completion: declared acceptance criteria + deterministic
	 *  evidence commands the BFF evaluator runs before completing the goal. */
	acceptanceCriteria?: string[] | null;
	evidencePlan?: { commands?: string[] } | null;
}

/**
 * Create the active goal, or REPLACE the existing DRIVABLE one — active or
 * budget_limited (codex `thread/goal/set`: a new objective rotates goal_id and
 * resets usage accounting). Replacing budget_limited too keeps a single
 * drivable row per session, so a re-set after budget exhaustion re-arms the
 * loop instead of leaving a stale steered row shadowing the new goal. One
 * active goal per session is enforced by uq_thread_goals_session_active.
 */
export async function createOrReplaceGoal(
	input: CreateGoalInput,
): Promise<ThreadGoalRow> {
	const database = requireDb();
	const maxIterations =
		typeof input.maxIterations === "number" && input.maxIterations > 0
			? Math.floor(input.maxIterations)
			: 50;
	const tokenBudget =
		typeof input.tokenBudget === "number" && input.tokenBudget > 0
			? Math.floor(input.tokenBudget)
			: null;
	const acceptanceCriteria =
		Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
			? input.acceptanceCriteria
			: null;
	const evidencePlan =
		input.evidencePlan &&
		Array.isArray(input.evidencePlan.commands) &&
		input.evidencePlan.commands.length
			? { commands: input.evidencePlan.commands }
			: null;

	return database.transaction(async (tx) => {
		const existing = await tx
			.select()
			.from(threadGoals)
			.where(
				and(
					eq(threadGoals.sessionId, input.sessionId),
					sql`${threadGoals.status} in ('active','budget_limited')`,
				),
			)
			.orderBy(
				sql`case when ${threadGoals.status} = 'active' then 0 else 1 end`,
				desc(threadGoals.createdAt),
			)
			.limit(1);
		if (existing[0]) {
			const [updated] = await tx
				.update(threadGoals)
				.set({
					objective: input.objective,
					tokenBudget,
					maxIterations,
					acceptanceCriteria,
					evidencePlan,
					workflowExecutionId: input.workflowExecutionId ?? null,
					goalId: crypto.randomUUID(),
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					iterations: 0,
					budgetSteeredAt: null,
					lastContinuationAt: null,
					stopReason: null,
					completedAt: null,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(threadGoals.id, existing[0].id))
				.returning();
			return updated;
		}
		const [inserted] = await tx
			.insert(threadGoals)
			.values({
				sessionId: input.sessionId,
				objective: input.objective,
				tokenBudget,
				maxIterations,
				acceptanceCriteria,
				evidencePlan,
				workflowExecutionId: input.workflowExecutionId ?? null,
			})
			.returning();
		return inserted;
	});
}

/** Mark the active/budget-limited goal complete (the only model-allowed transition). */
export async function markGoalComplete(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET status = 'complete', stop_reason = 'complete',
		    completed_at = now(), updated_at = now()
		WHERE session_id = ${sessionId} AND status in ('active','budget_limited')
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/** Pause the active goal (lifecycle interrupt). */
export async function pauseGoal(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET status = 'paused', stop_reason = 'interrupt', updated_at = now()
		WHERE session_id = ${sessionId} AND status = 'active'
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/**
 * Accrue a turn's token usage into the goal and refresh wall-clock time.
 * Flips active -> budget_limited when the (optional) token budget is crossed,
 * mirroring codex account_thread_goal_usage. Atomic so concurrent llm_usage
 * events don't lose updates.
 */
export async function accrueUsage(
	sessionId: string,
	deltaTokens: number,
): Promise<ThreadGoalRow | null> {
	const delta = Number.isFinite(deltaTokens) ? Math.max(0, Math.round(deltaTokens)) : 0;
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET tokens_used = tokens_used + ${delta},
		    time_used_seconds = floor(extract(epoch from (now() - created_at)))::int,
		    status = CASE
		      WHEN token_budget IS NOT NULL
		        AND (tokens_used + ${delta}) >= token_budget
		        AND status = 'active'
		      THEN 'budget_limited' ELSE status END,
		    updated_at = now()
		WHERE session_id = ${sessionId} AND status in ('active','budget_limited')
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/**
 * Atomically claim the next continuation turn: increments `iterations` and
 * stamps `last_continuation_at` IFF the goal is active, under the iteration
 * cap, and the last continuation is older than the spacing guard. Returns the
 * updated row (with the NEW iteration number) on success, null otherwise. This
 * is the exactly-once gate shared by inline event hooks and explicit kicks.
 */
export async function claimNextContinuation(
	sessionId: string,
	spacingSeconds: number = CONTINUATION_MIN_SPACING_SECONDS,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET iterations = iterations + 1,
		    last_continuation_at = now(),
		    time_used_seconds = floor(extract(epoch from (now() - created_at)))::int,
		    updated_at = now()
		WHERE session_id = ${sessionId}
		  AND status = 'active'
		  AND iterations < max_iterations
		  AND (last_continuation_at IS NULL
		       OR last_continuation_at < now() - (${spacingSeconds}::int * interval '1 second'))
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/**
 * Transition active -> budget_limited(stop_reason=iteration_cap) when the
 * iteration cap is reached, claiming the one-time wrap-up via budget_steered_at.
 */
export async function claimIterationCap(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET status = 'budget_limited', stop_reason = 'iteration_cap',
		    budget_steered_at = now(), updated_at = now()
		WHERE session_id = ${sessionId} AND status = 'active'
		  AND iterations >= max_iterations AND budget_steered_at IS NULL
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/**
 * Claim the one-time budget-limit wrap-up post (guarded by budget_steered_at)
 * so the steering prompt is injected exactly once when the budget is exhausted.
 */
export async function claimBudgetSteer(
	sessionId: string,
): Promise<ThreadGoalRow | null> {
	const rows = await requireDb().execute<Record<string, unknown>>(sql`
		UPDATE thread_goals
		SET budget_steered_at = now(), stop_reason = coalesce(stop_reason, 'budget'),
		    updated_at = now()
		WHERE session_id = ${sessionId} AND status = 'budget_limited'
		  AND budget_steered_at IS NULL
		RETURNING *
	`);
	return mapGoalRow(rows[0]);
}

/**
 * Most recent session_event (type + age) — the loop posts only when idle.
 */
/**
 * Intra-turn telemetry events that can land AFTER a turn-boundary
 * `session.status_idle` (esp. for workflow-driven CLI sessions, where the agy
 * adapter emits `agent.llm_usage` last). They are NOT a new turn or user input,
 * so the goal-loop idle gate must ignore them — otherwise a trailing llm_usage
 * makes "latest event is status_idle" false and stalls the event-driven loop.
 */
const GOAL_IDLE_IGNORED_EVENT_TYPES = [
	"agent.llm_usage",
	"agent.message",
	"agent.tool_use",
	"agent.tool_result",
	"agent.thinking",
	"agent.reasoning",
	"hook.decision",
];

export async function latestEventMeta(
	sessionId: string,
): Promise<{ type: string; ageSeconds: number } | null> {
	const rows = await requireDb()
		.select({
			type: sessionEvents.type,
			ageSeconds: sql<number>`extract(epoch from (now() - ${sessionEvents.createdAt}))`,
		})
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				notInArray(sessionEvents.type, GOAL_IDLE_IGNORED_EVENT_TYPES),
			),
		)
		.orderBy(desc(sessionEvents.sequence))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return { type: row.type, ageSeconds: Number(row.ageSeconds ?? 0) };
}

/**
 * Whether a `session.goal_completed` event has already been recorded for this
 * session. Used by the idle-rescue: a native-goal CLI (claude/codex) has no
 * thread_goals row, so the only durable signal that its goal finished is this
 * event. If the cooperative terminate raised on goal_completed was lost (e.g.
 * raced a post-completion "fallback" turn), the next clean end_turn idle re-fires
 * the terminate so the parent durable/run isn't wedged.
 */
export async function hasGoalCompletedEvent(sessionId: string): Promise<boolean> {
	const rows = await requireDb()
		.select({ sequence: sessionEvents.sequence })
		.from(sessionEvents)
		.where(
			and(
				eq(sessionEvents.sessionId, sessionId),
				eq(sessionEvents.type, "session.goal_completed"),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
/** Session stop/terminal state — the loop never drives a stopping session. */
export async function sessionStopState(
	sessionId: string,
): Promise<{ status: string; stopRequested: boolean } | null> {
	const rows = await requireDb()
		.select({
			status: sessions.status,
			stopRequestedAt: sessions.stopRequestedAt,
		})
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	return { status: row.status, stopRequested: row.stopRequestedAt !== null };
}

/** The session's parent workflow_execution_id (set only for workflow-driven
 *  durable/run sessions). Used by the goal loop to decide whether a completed
 *  goal should auto-terminate the session so the parent durable/run resumes. */
export async function getSessionWorkflowExecutionId(
	sessionId: string,
): Promise<string | null> {
	const rows = await requireDb()
		.select({ workflowExecutionId: sessions.workflowExecutionId })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	return rows[0]?.workflowExecutionId ?? null;
}
