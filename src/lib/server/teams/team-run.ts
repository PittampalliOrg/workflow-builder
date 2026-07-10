/**
 * Agent Teams — "team run" as a first-class workflow execution.
 *
 * A team run is a CONTAINER execution: unlike a dynamic-script run there is no
 * central Dapr workflow driving it (teammates are independent session_workflows),
 * so this execution is a passive rollup whose children are the teammate sessions
 * and whose status is COMPUTED from team_members + team_tasks. Creating it (and
 * stamping each session's workflow_execution_id) makes a team show up as ONE
 * unified run in the Fleet/runs list and gives it the run-detail cockpit
 * (rendered by the team-run engine branch → TeamRunPanel). Mirrors how the
 * dynamic-script run unifies many sessions under one execution.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { db as defaultDb } from "$lib/server/db";
import { getApplicationAdapters } from "$lib/server/application";

type Db = PostgresJsDatabase<Record<string, never>>;
const asDb = (db: Db | typeof defaultDb): Db => db as unknown as Db;

/** One shared synthetic "Agent Team Runs" workflow per project (satisfies the
 * non-null workflow_executions.workflowId FK without a schema migration). */
function teamRunWorkflowId(projectId: string): string {
	return `team-run-wf-${projectId}`;
}

async function ensureTeamRunWorkflow(
	projectId: string,
	userId: string,
	db: Db,
): Promise<string> {
	const id = teamRunWorkflowId(projectId);
	await db.execute(sql`
		INSERT INTO workflows (id, name, user_id, nodes, edges, project_id, engine_type)
		VALUES (${id}, 'Agent Team Runs', ${userId}, '[]'::jsonb, '[]'::jsonb, ${projectId}, 'team-run')
		ON CONFLICT (id) DO NOTHING
	`);
	return id;
}

/**
 * Ensure the team has a container execution; create it on first call. Also sets
 * teams.workflow_execution_id and stamps the lead session. Idempotent — returns
 * the existing execution id if the team already has one.
 */
export async function ensureTeamRunExecution(
	input: {
		teamId: string;
		projectId: string;
		leadSessionId: string;
		name?: string;
		prompt?: string;
	},
	database: Db | typeof defaultDb = defaultDb,
): Promise<string> {
	const db = asDb(database);
	const existing = (await db.execute(
		sql`SELECT workflow_execution_id FROM teams WHERE id = ${input.teamId}`,
	)) as Array<{ workflow_execution_id: string | null }>;
	const exId = existing[0]?.workflow_execution_id;
	if (exId) return exId;

	// The run owner is the lead session's user.
	const leadRows = (await db.execute(
		sql`SELECT user_id FROM sessions WHERE id = ${input.leadSessionId} LIMIT 1`,
	)) as Array<{ user_id: string | null }>;
	const userId = leadRows[0]?.user_id;
	if (!userId) throw new Error(`lead session ${input.leadSessionId} has no user`);

	const workflowId = await ensureTeamRunWorkflow(input.projectId, userId, db);
	const { id } = await getApplicationAdapters().workflowExecutions.create({
		workflowId,
		userId,
		projectId: input.projectId,
		status: "running",
		phase: "running",
		progress: 0,
		executionIr: {
			engine: "team-run",
			teamId: input.teamId,
			leadSessionId: input.leadSessionId,
			meta: {
				name: input.name ? `Team: ${input.name}` : "Agent Team Run",
				description: input.prompt ?? null,
			},
		},
		executionIrVersion: "team-run-1",
	});

	await db.execute(
		sql`UPDATE teams SET workflow_execution_id = ${id} WHERE id = ${input.teamId}`,
	);
	await db.execute(sql`
		UPDATE sessions SET workflow_execution_id = ${id}
		WHERE id = ${input.leadSessionId} AND workflow_execution_id IS NULL
	`);
	return id;
}

/** Stamp a teammate session with the team-run execution so it rolls up. */
export async function linkSessionToTeamRun(
	sessionId: string,
	executionId: string,
	database: Db | typeof defaultDb = defaultDb,
): Promise<void> {
	await asDb(database).execute(sql`
		UPDATE sessions SET workflow_execution_id = ${executionId} WHERE id = ${sessionId}
	`);
}

/**
 * Recompute the container execution's status from team state and persist it, so
 * the Fleet/runs list reflects the team live. Called by the team-driver on
 * member/task changes. No-op for teams without an execution row.
 */
export async function refreshTeamRunStatus(
	teamId: string,
	database: Db | typeof defaultDb = defaultDb,
): Promise<void> {
	const db = asDb(database);
	const t = (await db.execute(
		sql`SELECT workflow_execution_id FROM teams WHERE id = ${teamId}`,
	)) as Array<{ workflow_execution_id: string | null }>;
	const execId = t[0]?.workflow_execution_id;
	if (!execId) return;

	const rows = (await db.execute(sql`
		SELECT
			(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member') AS members,
			(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member' AND status = 'failed') AS failed,
			(SELECT count(*) FROM team_members WHERE team_id = ${teamId} AND role = 'member' AND status IN ('working')) AS working,
			(SELECT count(*) FROM team_tasks WHERE team_id = ${teamId}) AS tasks,
			(SELECT count(*) FROM team_tasks WHERE team_id = ${teamId} AND status = 'completed') AS done
	`)) as Array<{ members: number; failed: number; working: number; tasks: number; done: number }>;
	const r = rows[0] ?? { members: 0, failed: 0, working: 0, tasks: 0, done: 0 };
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
	const progress = tasks > 0 ? Math.round((done / tasks) * 100) : status === "success" ? 100 : 0;
	const terminal = status === "success" || status === "error";

	await db.execute(sql`
		UPDATE workflow_executions
		SET status = ${status}, phase = ${phase}, progress = ${progress},
		    completed_at = CASE WHEN ${terminal} THEN COALESCE(completed_at, now()) ELSE completed_at END
		WHERE id = ${execId}
	`);
}
