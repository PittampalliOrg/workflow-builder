/**
 * Agent Teams — BFF-side repo (teams / team_members).
 *
 * Raw `db.execute(sql\`...\`)` like goal-loop-store, so it runs against both
 * postgres-js and PGlite. The task list lives in team-tasks.ts (the claim). This
 * module owns team + membership rows and the name↔session resolution the BFF
 * team endpoints and the team-driver need.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";
import { db as defaultDb } from "$lib/server/db";

export type TeamsDb = PostgresJsDatabase<Record<string, never>>;

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
};

function rows<T>(r: unknown): T[] {
	return r as T[];
}

/** Create the team row if missing (idempotent on the deterministic team id). */
export async function ensureTeam(
	input: {
		teamId: string;
		leadSessionId: string;
		projectId: string;
		name?: string;
		workflowExecutionId?: string | null;
	},
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<void> {
	await db.execute(sql`
		INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
		VALUES (
			${input.teamId}, ${input.workflowExecutionId ?? null}, ${input.projectId},
			${input.name ?? `team-${input.teamId.slice(0, 8)}`}, ${input.leadSessionId}
		)
		ON CONFLICT (id) DO NOTHING
	`);
	// Ensure the lead is a member (role=lead). Its own session id is the member key.
	await db.execute(sql`
		INSERT INTO team_members (id, team_id, session_id, name, role, status)
		VALUES (${nanoid()}, ${input.teamId}, ${input.leadSessionId}, 'lead', 'lead', 'working')
		ON CONFLICT (session_id) DO NOTHING
	`);
}

export async function addMember(
	input: {
		teamId: string;
		sessionId: string;
		name: string;
		agentSlug?: string | null;
		model?: string | null;
		planModeRequired?: boolean;
	},
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamMemberRow> {
	const r = await db.execute<TeamMemberRow>(sql`
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

export async function listMembers(
	teamId: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamMemberRow[]> {
	const r = await db.execute<TeamMemberRow>(sql`
		SELECT * FROM team_members WHERE team_id = ${teamId} ORDER BY joined_at ASC
	`);
	return rows<TeamMemberRow>(r);
}

export type TeamRow = {
	id: string;
	name: string;
	status: string;
	lead_session_id: string;
	token_budget: number | null;
};

export async function getTeam(
	teamId: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamRow | null> {
	const r = await db.execute<TeamRow>(sql`
		SELECT id, name, status, lead_session_id, token_budget FROM teams WHERE id = ${teamId}
	`);
	return rows<TeamRow>(r)[0] ?? null;
}

export async function listTeamTasks(
	teamId: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<
	Array<{
		id: string;
		title: string;
		status: string;
		assignee_session_id: string | null;
		depends_on: string[];
	}>
> {
	const r = await db.execute(sql`
		SELECT id, title, status, assignee_session_id, depends_on
		FROM team_tasks WHERE team_id = ${teamId} ORDER BY created_at ASC
	`);
	return rows(r);
}

export async function getMemberByName(
	teamId: string,
	name: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamMemberRow | null> {
	const r = await db.execute<TeamMemberRow>(sql`
		SELECT * FROM team_members WHERE team_id = ${teamId} AND name = ${name} LIMIT 1
	`);
	return rows<TeamMemberRow>(r)[0] ?? null;
}

/** All members currently idle (across active teams) — the tick's lost-idle set. */
export async function listIdleMembers(
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamMemberRow[]> {
	const r = await db.execute<TeamMemberRow>(sql`
		SELECT * FROM team_members WHERE status = 'idle'
	`);
	return rows<TeamMemberRow>(r);
}

export async function getMemberBySession(
	sessionId: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<TeamMemberRow | null> {
	const r = await db.execute<TeamMemberRow>(sql`
		SELECT * FROM team_members WHERE session_id = ${sessionId} LIMIT 1
	`);
	return rows<TeamMemberRow>(r)[0] ?? null;
}

export async function setMemberStatus(
	sessionId: string,
	status: "working" | "idle" | "failed" | "shutdown",
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<void> {
	await db.execute(sql`
		UPDATE team_members SET status = ${status}, updated_at = now()
		WHERE session_id = ${sessionId}
	`);
}

/** Resolve an agent slug to its id within a project, for peer spawn. */
export async function resolveAgentIdBySlug(
	projectId: string,
	slug: string,
	db: TeamsDb = defaultDb as unknown as TeamsDb,
): Promise<{ id: string } | null> {
	const r = await db.execute<{ id: string }>(sql`
		SELECT id FROM agents
		WHERE project_id = ${projectId} AND slug = ${slug}
		LIMIT 1
	`);
	return rows<{ id: string }>(r)[0] ?? null;
}
