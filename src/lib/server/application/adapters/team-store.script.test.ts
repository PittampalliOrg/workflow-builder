/**
 * Script-led team store methods against real PGlite: lead-anchor provisioning
 * idempotency, execution context, assigned task creation, execution adoption in
 * ensureTeamRunExecution, and the refreshTeamRunStatus engine guard (the
 * adoption-clobber bug this feature must not introduce).
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";
import { ensureTeam } from "$lib/server/teams/team-repo";
import { ensureTeamRunExecution } from "$lib/server/teams/team-run";

type Pglite = ReturnType<typeof createPgliteDb>["db"];

const EXEC = "exec-abc123";

async function fresh(): Promise<{ db: Pglite; store: TeamStore }> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(
			`CREATE TABLE agents (id text primary key, name text not null, slug text not null unique, model jsonb, is_default boolean default false, is_enabled boolean default true, is_archived boolean default false, user_id text)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE sessions (id text primary key, user_id text not null, project_id text, agent_id text not null references agents(id), status text default 'idle', title text, workflow_execution_id text, dapr_instance_id text, runtime_sandbox_name text, last_event_at timestamp)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE workflow_executions (id text primary key, user_id text not null, project_id text, status text default 'running', phase text, progress int default 0, execution_ir jsonb, completed_at timestamp)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE teams (id text primary key, workflow_execution_id text, project_id text not null, name text, lead_session_id text not null, status text default 'active', token_budget int, created_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_members (id text primary key, team_id text not null, session_id text unique not null, agent_slug text, name text not null, role text default 'member', model text, status text default 'working', plan_mode_required boolean default false, joined_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_tasks (id text primary key, team_id text not null, title text not null, description text, status text default 'pending', assignee_session_id text, depends_on jsonb default '[]'::jsonb, created_by_session_id text, created_at timestamp default now(), updated_at timestamp default now(), completed_at timestamp, completion_note text)`,
		),
	);
	await db.execute(sql`
		INSERT INTO workflow_executions (id, user_id, project_id, status, execution_ir)
		VALUES (${EXEC}, 'user-1', 'proj-1', 'running', '{"engine":"dynamic-script"}'::jsonb)
	`);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

describe("script-led team store", () => {
	let db: Pglite;
	let store: TeamStore;
	beforeEach(async () => {
		({ db, store } = await fresh());
	});

	it("getExecutionContext returns owner scope; null for unknown", async () => {
		expect(await store.getExecutionContext(EXEC)).toEqual({
			userId: "user-1",
			projectId: "proj-1",
		});
		expect(await store.getExecutionContext("nope")).toBeNull();
	});

	it("ensureScriptLeadSession is idempotent and stamps the execution", async () => {
		const input = {
			sessionId: `dsw-team-lead-${EXEC}`,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		};
		await store.ensureScriptLeadSession(input);
		await store.ensureScriptLeadSession(input); // no throw on repeat
		const rows = (await db.execute(
			sql`SELECT agent_id, workflow_execution_id, status FROM sessions WHERE id = ${input.sessionId}`,
		)) as Array<{ agent_id: string; workflow_execution_id: string; status: string }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].agent_id).toBe("script-team-lead");
		expect(rows[0].workflow_execution_id).toBe(EXEC);
		const agents = (await db.execute(
			sql`SELECT is_archived FROM agents WHERE slug = 'script-team-lead'`,
		)) as Array<{ is_archived: boolean }>;
		expect(agents).toHaveLength(1);
		expect(agents[0].is_archived).toBe(true);
	});

	it("createTask supports pre-assignment (in_progress, not claimable)", async () => {
		const task = await store.createTask({
			teamId: "t1",
			title: "assigned work",
			assigneeSessionId: "sess-m1",
			status: "in_progress",
		});
		expect(task.status).toBe("in_progress");
		expect(task.assignee_session_id).toBe("sess-m1");
		// Pre-assigned tasks must not be claimable.
		expect(await store.claimNextTask({ teamId: "t1", sessionId: "thief" })).toBeNull();
		// Default stays pending/unassigned.
		const plain = await store.createTask({ teamId: "t1", title: "open work" });
		expect(plain.status).toBe("pending");
		expect(plain.assignee_session_id).toBeNull();
	});

	it("ensureTeamRunExecution ADOPTS the lead's existing execution", async () => {
		const lead = `dsw-team-lead-${EXEC}`;
		await store.ensureScriptLeadSession({
			sessionId: lead,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		});
		await ensureTeam({ teamId: `team-${EXEC}`, leadSessionId: lead, projectId: "proj-1" }, store);
		const execId = await ensureTeamRunExecution(
			{ teamId: `team-${EXEC}`, projectId: "proj-1", leadSessionId: lead },
			store,
		);
		expect(execId).toBe(EXEC); // adopted, not synthesized
		expect(await store.getTeamExecutionId(`team-${EXEC}`)).toBe(EXEC);
		// No synthetic execution row appeared.
		const execs = (await db.execute(
			sql`SELECT count(*)::int AS n FROM workflow_executions`,
		)) as Array<{ n: number }>;
		expect(Number(execs[0].n)).toBe(1);
	});

	it("refreshTeamRunStatus refuses to touch a non-team-run execution", async () => {
		const lead = `dsw-team-lead-${EXEC}`;
		await store.ensureScriptLeadSession({
			sessionId: lead,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		});
		await ensureTeam({ teamId: `team-${EXEC}`, leadSessionId: lead, projectId: "proj-1" }, store);
		await store.setTeamExecutionId(`team-${EXEC}`, EXEC);
		// One completed task + zero working members would reduce to success —
		// but the adopted execution is engine dynamic-script, so NOTHING changes.
		await store.createTask({ teamId: `team-${EXEC}`, title: "done", status: "in_progress" });
		await db.execute(
			sql.raw(`UPDATE team_tasks SET status='completed', completed_at=now()`),
		);
		await store.refreshTeamRunStatus(`team-${EXEC}`);
		const rows = (await db.execute(
			sql`SELECT status, progress FROM workflow_executions WHERE id = ${EXEC}`,
		)) as Array<{ status: string; progress: number }>;
		expect(rows[0].status).toBe("running"); // untouched
	});

	it("refreshTeamRunStatus still reduces a synthetic team-run execution", async () => {
		await db.execute(sql`
			INSERT INTO workflow_executions (id, user_id, project_id, status, execution_ir)
			VALUES ('synth-1', 'user-1', 'proj-1', 'running', '{"engine":"team-run"}'::jsonb)
		`);
		await ensureTeam({ teamId: "team-x", leadSessionId: "lead-x", projectId: "proj-1" }, store);
		await store.setTeamExecutionId("team-x", "synth-1");
		await store.addMember({ teamId: "team-x", sessionId: "m-1", name: "worker" });
		await store.setMemberStatus("m-1", "idle");
		const t = await store.createTask({ teamId: "team-x", title: "only" });
		await store.completeTask({ teamId: "team-x", taskId: t.id });
		await store.refreshTeamRunStatus("team-x");
		const rows = (await db.execute(
			sql`SELECT status, progress FROM workflow_executions WHERE id = 'synth-1'`,
		)) as Array<{ status: string; progress: number }>;
		expect(rows[0].status).toBe("success");
		expect(Number(rows[0].progress)).toBe(100);
	});
});
