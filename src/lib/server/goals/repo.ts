import { and, desc, eq, sql } from "drizzle-orm";
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
 * a race between the inline event hook and the backstop tick reaper.
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

/** The goal the loop drives (active or budget_limited), if any. */
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
		.limit(1);
	return rows[0] ?? null;
}

export interface CreateGoalInput {
	sessionId: string;
	objective: string;
	tokenBudget?: number | null;
	maxIterations?: number;
	workflowExecutionId?: string | null;
}

/**
 * Create the active goal, or REPLACE the existing active one (codex
 * `thread/goal/set`: a new objective rotates goal_id and resets usage
 * accounting). One active goal per session is enforced by the partial unique
 * index uq_thread_goals_session_active.
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

	return database.transaction(async (tx) => {
		const existing = await tx
			.select()
			.from(threadGoals)
			.where(
				and(
					eq(threadGoals.sessionId, input.sessionId),
					eq(threadGoals.status, "active"),
				),
			)
			.limit(1);
		if (existing[0]) {
			const [updated] = await tx
				.update(threadGoals)
				.set({
					objective: input.objective,
					tokenBudget,
					maxIterations,
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
 * is the exactly-once gate shared by the inline event hook and the tick reaper.
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

/** Type of the most recent session_event — the loop posts only when idle. */
export async function latestEventType(
	sessionId: string,
): Promise<string | null> {
	const rows = await requireDb()
		.select({ type: sessionEvents.type })
		.from(sessionEvents)
		.where(eq(sessionEvents.sessionId, sessionId))
		.orderBy(desc(sessionEvents.sequence))
		.limit(1);
	return rows[0]?.type ?? null;
}

/**
 * Sessions with a drivable goal not continued within `staleSeconds` — the tick
 * reaper re-drives these as the crash-safe backstop (covers a missed idle
 * event, a goal set after the idle fired, a raise that failed because the pod
 * wasn't ready, or a BFF restart mid-loop). The per-session idle gate + atomic
 * claim in driveContinuationIfIdle make re-driving safe and idempotent.
 */
export async function listStalledDrivableSessions(
	staleSeconds: number,
	limit: number,
): Promise<string[]> {
	const rows = await requireDb().execute<{ session_id: string }>(sql`
		SELECT session_id FROM thread_goals
		WHERE status in ('active','budget_limited')
		  AND (last_continuation_at IS NULL
		       OR last_continuation_at < now() - (${staleSeconds}::int * interval '1 second'))
		ORDER BY updated_at ASC
		LIMIT ${limit}
	`);
	return rows.map((r) => r.session_id);
}

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
