/**
 * Goal DB layer (thread_goals)
 *
 * Direct pg access to the shared thread_goals table for the goal tools. Writes
 * the goal row only; the autonomous continuation LOOP is driven by the BFF
 * (it watches session events + re-injects continuation turns) — when the agent
 * calls create_goal mid-turn, the BFF picks the new goal up on the next idle.
 */

import { nanoid } from "nanoid";
import { getPool } from "./db.js";

export type ThreadGoalRecord = {
	id: string;
	session_id: string;
	goal_id: string;
	objective: string;
	status: string;
	token_budget: number | null;
	tokens_used: number;
	time_used_seconds: number;
	iterations: number;
	max_iterations: number;
	stop_reason: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

export async function createOrReplaceGoalForSession(input: {
	sessionId: string;
	objective: string;
	tokenBudget?: number | null;
	maxIterations?: number;
}): Promise<ThreadGoalRecord> {
	const tokenBudget =
		typeof input.tokenBudget === "number" && input.tokenBudget > 0
			? Math.floor(input.tokenBudget)
			: null;
	const maxIterations =
		typeof input.maxIterations === "number" && input.maxIterations > 0
			? Math.floor(input.maxIterations)
			: 50;

	const client = await getPool().connect();
	try {
		await client.query("BEGIN");
		const existing = await client.query<{ id: string }>(
			`SELECT id FROM thread_goals WHERE session_id = $1 AND status = 'active' LIMIT 1`,
			[input.sessionId],
		);
		let row: ThreadGoalRecord;
		if (existing.rows[0]) {
			// Replace the active goal in place: rotate goal_id, reset usage
			// accounting (codex thread/goal/set semantics).
			const res = await client.query<ThreadGoalRecord>(
				`UPDATE thread_goals
				 SET objective = $2, token_budget = $3, max_iterations = $4, goal_id = $5,
				     status = 'active', tokens_used = 0, time_used_seconds = 0, iterations = 0,
				     budget_steered_at = NULL, last_continuation_at = NULL, stop_reason = NULL,
				     completed_at = NULL, created_at = now(), updated_at = now()
				 WHERE id = $1
				 RETURNING *`,
				[
					existing.rows[0].id,
					input.objective,
					tokenBudget,
					maxIterations,
					nanoid(),
				],
			);
			row = res.rows[0];
		} else {
			const res = await client.query<ThreadGoalRecord>(
				`INSERT INTO thread_goals
				   (id, session_id, goal_id, objective, token_budget, max_iterations)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING *`,
				[
					nanoid(),
					input.sessionId,
					nanoid(),
					input.objective,
					tokenBudget,
					maxIterations,
				],
			);
			row = res.rows[0];
		}
		await client.query("COMMIT");
		return row;
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
}

export async function getGoalForSession(
	sessionId: string,
): Promise<ThreadGoalRecord | null> {
	const res = await getPool().query<ThreadGoalRecord>(
		`SELECT * FROM thread_goals WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1`,
		[sessionId],
	);
	return res.rows[0] ?? null;
}

/** Mark the active/budget-limited goal complete (the only model transition). */
export async function completeGoalForSession(
	sessionId: string,
): Promise<ThreadGoalRecord | null> {
	const res = await getPool().query<ThreadGoalRecord>(
		`UPDATE thread_goals
		 SET status = 'complete', stop_reason = 'complete',
		     completed_at = now(), updated_at = now()
		 WHERE session_id = $1 AND status in ('active','budget_limited')
		 RETURNING *`,
		[sessionId],
	);
	return res.rows[0] ?? null;
}
