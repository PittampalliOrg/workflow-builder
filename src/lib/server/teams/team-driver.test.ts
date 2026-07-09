/**
 * team-driver reactive coordinator — logic tests against real PGlite, with the
 * message-delivery boundary (injectTeamMessage) mocked so we assert WHO gets
 * notified and WHY without a live runtime.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";

type InjectArg = {
	recipientSessionId: string;
	fromName: string;
	content: string;
	kind: string;
	sourceEventId: string;
};
const injectMock = vi.fn(async (_input: InjectArg) => {});
vi.mock("$lib/server/teams/team-messaging", () => ({
	injectTeamMessage: (input: InjectArg) => injectMock(input),
}));

// Import AFTER the mock is registered.
import { onTeamSessionEvent } from "$lib/server/teams/team-driver";
import { addMember, ensureTeam, type TeamsDb } from "$lib/server/teams/team-repo";

async function freshDb(): Promise<TeamsDb> {
	const { db } = createPgliteDb();
	const t = db as unknown as TeamsDb;
	await t.execute(
		sql.raw(
			`CREATE TABLE teams (id text primary key, workflow_execution_id text, project_id text not null, name text, lead_session_id text not null, status text default 'active', token_budget int, created_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await t.execute(
		sql.raw(
			`CREATE TABLE team_members (id text primary key, team_id text not null, session_id text unique not null, agent_slug text, name text not null, role text default 'member', model text, status text default 'working', plan_mode_required boolean default false, joined_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await t.execute(
		sql.raw(
			`CREATE TABLE team_tasks (id text primary key, team_id text not null, title text not null, description text, status text default 'pending', assignee_session_id text, depends_on jsonb default '[]'::jsonb, created_by_session_id text, created_at timestamp default now(), updated_at timestamp default now(), completed_at timestamp)`,
		),
	);
	return t;
}

function recipients(): InjectArg[] {
	return injectMock.mock.calls.map((c) => c[0]);
}

describe("team-driver onTeamSessionEvent", () => {
	beforeEach(() => injectMock.mockClear());

	it("notifies the lead on ANY teammate idle (incl. goal_stop) + nudges when work exists", async () => {
		const db = await freshDb();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, db);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, db);
		// a claimable task exists → the auto-claim nudge should fire
		await db.execute(
			sql.raw(`INSERT INTO team_tasks (id, team_id, title) VALUES ('tk1','t1','do it')`),
		);
		await onTeamSessionEvent(
			"mate1",
			{ type: "session.status_idle", data: { stop_reason: { type: "goal_stop" } } },
			db,
		);
		const r = recipients();
		// lead gets a team-idle notice
		expect(r.some((a) => a.recipientSessionId === "lead1" && a.kind === "team-idle")).toBe(true);
		// teammate gets the auto-claim nudge (there is claimable work)
		expect(r.some((a) => a.recipientSessionId === "mate1" && a.kind === "team-idle")).toBe(true);
	});

	it("does NOT nudge an idle teammate when there is no claimable work (loop guard)", async () => {
		const db = await freshDb();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, db);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, db);
		// no tasks → lead still notified, but NO nudge to the teammate
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, db);
		const r = recipients();
		expect(r.some((a) => a.recipientSessionId === "lead1")).toBe(true);
		expect(r.some((a) => a.recipientSessionId === "mate1")).toBe(false);
	});

	it("does not notify for the lead's own idle", async () => {
		const db = await freshDb();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, db);
		await onTeamSessionEvent("lead1", { type: "session.status_idle", data: {} }, db);
		expect(injectMock).not.toHaveBeenCalled();
	});

	it("is a no-op for a non-team session", async () => {
		const db = await freshDb();
		await onTeamSessionEvent("stranger", { type: "session.status_idle", data: {} }, db);
		expect(injectMock).not.toHaveBeenCalled();
	});

	it("ignores non-idle events", async () => {
		const db = await freshDb();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, db);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, db);
		await onTeamSessionEvent("mate1", { type: "agent.message", data: {} }, db);
		expect(injectMock).not.toHaveBeenCalled();
	});
});
