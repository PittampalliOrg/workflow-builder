/**
 * Agent Teams — shared task list (Phase 1).
 *
 * Canonical, single-source-of-truth for the team_tasks claim. The atomic claim
 * mirrors GoalLoopStore.claimNextContinuation: a single guarded statement that
 * both selects AND mutates, so it is race-safe without app-level locking. The
 * SQL turn-lock (FOR UPDATE SKIP LOCKED) is what the Dapr-native re-evaluation
 * chose over an actor lock — it keeps the list queryable (UI/deps/audit/trace)
 * while giving the same no-double-claim guarantee.
 *
 * The MCP `claim_task` tool reaches this through the BFF internal endpoint
 * (POST /api/internal/team/[teamId]/claim), the same way update_goal reaches the
 * evaluator — so the claim SQL exists in exactly one place and is unit-tested
 * against PGlite (see team-tasks.test.ts).
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";

// Matches the shared `Database = typeof defaultDb` used by the other adapters;
// PGlite is cast to this same type by createPgliteDb, so tests stay identical.
export type TeamTasksDb = PostgresJsDatabase<Record<string, never>>;

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

function firstRow(rows: unknown): TeamTaskRow | null {
	const list = rows as TeamTaskRow[];
	return list[0] ?? null;
}

export async function createTask(
	db: TeamTasksDb,
	input: {
		teamId: string;
		title: string;
		description?: string | null;
		dependsOn?: string[];
		createdBySessionId?: string | null;
	},
): Promise<TeamTaskRow> {
	const rows = await db.execute<TeamTaskRow>(sql`
		INSERT INTO team_tasks
			(id, team_id, title, description, depends_on, created_by_session_id)
		VALUES (
			${nanoid()}, ${input.teamId}, ${input.title}, ${input.description ?? null},
			${JSON.stringify(input.dependsOn ?? [])}::jsonb, ${input.createdBySessionId ?? null}
		)
		RETURNING *
	`);
	return firstRow(rows) as TeamTaskRow;
}

/**
 * Atomically claim the oldest eligible task for `sessionId`. Eligible = pending,
 * unassigned, and every id in depends_on is completed. Returns the claimed task,
 * or null when nothing is claimable. FOR UPDATE SKIP LOCKED lets N idle
 * teammates claim concurrently without contending on the same row.
 *
 * NOTE ON TESTING: PGlite is single-connection, so its unit tests prove the
 * claim CONTRACT (select-and-mutate exclusion, dependency gating) deterministically
 * but cannot exercise true multi-connection SKIP-LOCKED contention. That final
 * guarantee is validated by the dev-cluster end-to-end run (see
 * scripts/verify-agent-teams-dev.sh) against real Postgres.
 */
export async function claimNextTask(
	db: TeamTasksDb,
	input: { teamId: string; sessionId: string },
): Promise<TeamTaskRow | null> {
	const rows = await db.execute<TeamTaskRow>(sql`
		UPDATE team_tasks
		SET status = 'in_progress', assignee_session_id = ${input.sessionId}, updated_at = now()
		WHERE id = (
			SELECT t.id FROM team_tasks t
			WHERE t.team_id = ${input.teamId}
			  AND t.status = 'pending'
			  AND t.assignee_session_id IS NULL
			  AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements_text(t.depends_on) dep
				JOIN team_tasks d ON d.id = dep
				WHERE d.status <> 'completed'
			  )
			ORDER BY t.created_at
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		RETURNING *
	`);
	return firstRow(rows);
}

/** Mark a claimed task completed. Unblocks dependents on the next claim. */
export async function completeTask(
	db: TeamTasksDb,
	input: { teamId: string; taskId: string },
): Promise<TeamTaskRow | null> {
	const rows = await db.execute<TeamTaskRow>(sql`
		UPDATE team_tasks
		SET status = 'completed', completed_at = now(), updated_at = now()
		WHERE team_id = ${input.teamId} AND id = ${input.taskId}
		RETURNING *
	`);
	return firstRow(rows);
}
