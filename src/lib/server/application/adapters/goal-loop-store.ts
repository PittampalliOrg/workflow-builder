import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	sessions,
	sessionEvents,
	threadGoals,
} from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	GoalLoopEventMeta,
	GoalLoopSessionStopState,
	GoalLoopStore,
	SessionGoalRecord,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;

export const CONTINUATION_MIN_SPACING_SECONDS = 2;

/**
 * Intra-turn telemetry events that can land after a turn-boundary
 * `session.status_idle`. They are not a new turn or user input, so the goal
 * loop idle gate ignores them.
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

export class PostgresGoalLoopStore implements GoalLoopStore {
	constructor(private readonly getDatabase: () => Database = requirePostgresDb) {}

	async getCurrentGoal(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database()
			.select()
			.from(threadGoals)
			.where(eq(threadGoals.sessionId, sessionId))
			.orderBy(desc(threadGoals.createdAt))
			.limit(1);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async getDrivableGoal(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database()
			.select()
			.from(threadGoals)
			.where(
				and(
					eq(threadGoals.sessionId, sessionId),
					inArray(threadGoals.status, ["active", "budget_limited"]),
				),
			)
			.orderBy(
				sql`case when ${threadGoals.status} = 'active' then 0 else 1 end`,
				desc(threadGoals.createdAt),
			)
			.limit(1);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async accrueUsage(
		sessionId: string,
		deltaTokens: number,
	): Promise<SessionGoalRecord | null> {
		const delta = Number.isFinite(deltaTokens)
			? Math.max(0, Math.round(deltaTokens))
			: 0;
		const rows = await this.database().execute<Record<string, unknown>>(sql`
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
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async claimNextContinuation(
		sessionId: string,
		spacingSeconds = CONTINUATION_MIN_SPACING_SECONDS,
	): Promise<SessionGoalRecord | null> {
		const rows = await this.database().execute<Record<string, unknown>>(sql`
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
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async claimIterationCap(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database().execute<Record<string, unknown>>(sql`
			UPDATE thread_goals
			SET status = 'budget_limited', stop_reason = 'iteration_cap',
			    budget_steered_at = now(), updated_at = now()
			WHERE session_id = ${sessionId} AND status = 'active'
			  AND iterations >= max_iterations AND budget_steered_at IS NULL
			RETURNING *
		`);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async claimBudgetSteer(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database().execute<Record<string, unknown>>(sql`
			UPDATE thread_goals
			SET budget_steered_at = now(), stop_reason = coalesce(stop_reason, 'budget'),
			    updated_at = now()
			WHERE session_id = ${sessionId} AND status = 'budget_limited'
			  AND budget_steered_at IS NULL
			RETURNING *
		`);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async markGoalComplete(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database().execute<Record<string, unknown>>(sql`
			UPDATE thread_goals
			SET status = 'complete', stop_reason = 'complete',
			    completed_at = now(), updated_at = now()
			WHERE session_id = ${sessionId} AND status in ('active','budget_limited')
			RETURNING *
		`);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async pauseGoal(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database().execute<Record<string, unknown>>(sql`
			UPDATE thread_goals
			SET status = 'paused', stop_reason = 'interrupt', updated_at = now()
			WHERE session_id = ${sessionId} AND status = 'active'
			RETURNING *
		`);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async latestEventMeta(sessionId: string): Promise<GoalLoopEventMeta | null> {
		const rows = await this.database()
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

	async hasGoalCompletedEvent(sessionId: string): Promise<boolean> {
		const rows = await this.database()
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

	async sessionStopState(
		sessionId: string,
	): Promise<GoalLoopSessionStopState | null> {
		const rows = await this.database()
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

	async getSessionWorkflowExecutionId(sessionId: string): Promise<string | null> {
		const rows = await this.database()
			.select({ workflowExecutionId: sessions.workflowExecutionId })
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		return rows[0]?.workflowExecutionId ?? null;
	}

	private database(): Database {
		return this.getDatabase();
	}
}

function toSessionGoalRecord(row: unknown): SessionGoalRecord | null {
	if (!row || typeof row !== "object") return null;
	const r = row as Record<string, unknown>;
	const value = (camel: string, snake: string = camel) => r[camel] ?? r[snake];
	const ts = (v: unknown): Date | null =>
		v instanceof Date ? v : typeof v === "string" ? new Date(v) : null;
	return {
		id: String(value("id")),
		sessionId: String(value("sessionId", "session_id")),
		goalId: String(value("goalId", "goal_id")),
		objective: String(value("objective")),
		status: String(value("status")),
		tokenBudget:
			value("tokenBudget", "token_budget") === null ||
			value("tokenBudget", "token_budget") === undefined
				? null
				: Number(value("tokenBudget", "token_budget")),
		tokensUsed: Number(value("tokensUsed", "tokens_used") ?? 0),
		timeUsedSeconds: Number(value("timeUsedSeconds", "time_used_seconds") ?? 0),
		iterations: Number(value("iterations") ?? 0),
		maxIterations: Number(value("maxIterations", "max_iterations") ?? 0),
		acceptanceCriteria: (value(
			"acceptanceCriteria",
			"acceptance_criteria",
		) ?? null) as string[] | null,
		evidencePlan: (value("evidencePlan", "evidence_plan") ?? null) as {
			commands?: string[];
		} | null,
		budgetSteeredAt: ts(value("budgetSteeredAt", "budget_steered_at")),
		lastContinuationAt: ts(value("lastContinuationAt", "last_continuation_at")),
		stopReason:
			value("stopReason", "stop_reason") === null ||
			value("stopReason", "stop_reason") === undefined
				? null
				: String(value("stopReason", "stop_reason")),
		workflowExecutionId:
			value("workflowExecutionId", "workflow_execution_id") === null ||
			value("workflowExecutionId", "workflow_execution_id") === undefined
				? null
				: String(value("workflowExecutionId", "workflow_execution_id")),
		createdAt: ts(value("createdAt", "created_at")) ?? new Date(0),
		updatedAt: ts(value("updatedAt", "updated_at")) ?? new Date(0),
		completedAt: ts(value("completedAt", "completed_at")),
	};
}
