/**
 * Team DB layer (teams / team_members / team_tasks)
 *
 * Direct pg access for the read + task-authoring team tools, mirroring goal-db.ts.
 * The stateful/coordination operations that need session spawning, event
 * injection, NATS, or the Lifecycle Controller (spawn_teammate, send_message,
 * broadcast, shutdown_teammate, claim_task) go through the BFF internal API
 * instead — see team-tools.ts. claim_task in particular routes to the BFF so the
 * atomic claim SQL lives in exactly one place (src/lib/server/teams/team-tasks.ts,
 * PGlite-unit-tested).
 */

import { nanoid } from "nanoid";
import { getPool } from "./db.js";

export type TeamMemberRecord = {
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

export type TeamTaskRecord = {
	id: string;
	team_id: string;
	title: string;
	description: string | null;
	status: string;
	assignee_session_id: string | null;
	depends_on: string[];
	created_by_session_id: string | null;
	created_at: string;
	updated_at: string;
	completed_at: string | null;
};

export async function getTeam(
	teamId: string,
): Promise<{ id: string; name: string; status: string; lead_session_id: string } | null> {
	const res = await getPool().query<{
		id: string;
		name: string;
		status: string;
		lead_session_id: string;
	}>(`SELECT id, name, status, lead_session_id FROM teams WHERE id = $1`, [teamId]);
	return res.rows[0] ?? null;
}

export async function listMembers(teamId: string): Promise<TeamMemberRecord[]> {
	const res = await getPool().query<TeamMemberRecord>(
		`SELECT * FROM team_members WHERE team_id = $1 ORDER BY joined_at ASC`,
		[teamId],
	);
	return res.rows;
}

export async function listTasks(teamId: string): Promise<TeamTaskRecord[]> {
	const res = await getPool().query<TeamTaskRecord>(
		`SELECT * FROM team_tasks WHERE team_id = $1 ORDER BY created_at ASC`,
		[teamId],
	);
	return res.rows;
}

export async function createTask(input: {
	teamId: string;
	title: string;
	description?: string | null;
	dependsOn?: string[];
	createdBySessionId?: string | null;
}): Promise<TeamTaskRecord> {
	const res = await getPool().query<TeamTaskRecord>(
		`INSERT INTO team_tasks
		   (id, team_id, title, description, depends_on, created_by_session_id)
		 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
		 RETURNING *`,
		[
			nanoid(),
			input.teamId,
			input.title,
			input.description ?? null,
			JSON.stringify(input.dependsOn ?? []),
			input.createdBySessionId ?? null,
		],
	);
	return res.rows[0];
}

/**
 * Mark a task completed (the model-settable transition). Scoped to the team so a
 * teammate cannot complete another team's task. Emitting the `task.completed`
 * session event that unblocks dependents is the BFF/driver's job.
 */
export async function completeTask(input: {
	teamId: string;
	taskId: string;
}): Promise<TeamTaskRecord | null> {
	const res = await getPool().query<TeamTaskRecord>(
		`UPDATE team_tasks
		 SET status = 'completed', completed_at = now(), updated_at = now()
		 WHERE team_id = $1 AND id = $2
		 RETURNING *`,
		[input.teamId, input.taskId],
	);
	return res.rows[0] ?? null;
}
