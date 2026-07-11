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
import { addMember, ensureTeam } from "$lib/server/teams/team-repo";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";

type PgliteHandle = ReturnType<typeof createPgliteDb>["db"];

/** A PGlite-backed TeamStore + the raw handle (for seeding rows the store has no
 * writer for, e.g. team_tasks in these driver tests). */
async function fresh(): Promise<{ db: PgliteHandle; store: TeamStore }> {
	const { db } = createPgliteDb();
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
	// Minimal session_events for the token-budget aggregate (getTeamTokensUsed).
	await db.execute(
		sql.raw(
			`CREATE TABLE session_events (id text primary key, session_id text not null, type text not null, data jsonb not null default '{}'::jsonb, created_at timestamp default now())`,
		),
	);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

function recipients(): InjectArg[] {
	return injectMock.mock.calls.map((c) => c[0]);
}

describe("team-driver onTeamSessionEvent", () => {
	beforeEach(() => injectMock.mockClear());

	it("notifies the lead on ANY teammate idle (incl. goal_stop) + nudges when work exists", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, store);
		// a claimable task exists → the auto-claim nudge should fire
		await db.execute(
			sql.raw(`INSERT INTO team_tasks (id, team_id, title) VALUES ('tk1','t1','do it')`),
		);
		await onTeamSessionEvent(
			"mate1",
			{ type: "session.status_idle", data: { stop_reason: { type: "goal_stop" } } },
			store,
		);
		const r = recipients();
		// lead gets a team-idle notice
		expect(r.some((a) => a.recipientSessionId === "lead1" && a.kind === "team-idle")).toBe(true);
		// teammate gets the auto-claim nudge (there is claimable work)
		expect(r.some((a) => a.recipientSessionId === "mate1" && a.kind === "team-idle")).toBe(true);
	});

	it("does NOT nudge an idle teammate when there is no claimable work (loop guard)", async () => {
		const { store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, store);
		// no tasks → lead still notified, but NO nudge to the teammate
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const r = recipients();
		expect(r.some((a) => a.recipientSessionId === "lead1")).toBe(true);
		expect(r.some((a) => a.recipientSessionId === "mate1")).toBe(false);
	});

	it("does not notify for the lead's own idle", async () => {
		const { store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await onTeamSessionEvent("lead1", { type: "session.status_idle", data: {} }, store);
		expect(injectMock).not.toHaveBeenCalled();
	});

	it("is a no-op for a non-team session", async () => {
		const { store } = await fresh();
		await onTeamSessionEvent("stranger", { type: "session.status_idle", data: {} }, store);
		expect(injectMock).not.toHaveBeenCalled();
	});

	it("ignores non-idle events", async () => {
		const { store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, store);
		await onTeamSessionEvent("mate1", { type: "agent.message", data: {} }, store);
		expect(injectMock).not.toHaveBeenCalled();
	});

	it("nudges an idle member that still HOLDS an in_progress task (deadlock breaker)", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "researcher" }, store);
		// mate1 claimed tk1 but went idle without completing it — NOT claimable,
		// so the claim nudge can't fire; the hold nudge must.
		await db.execute(
			sql.raw(
				`INSERT INTO team_tasks (id, team_id, title, status, assignee_session_id) VALUES ('tk1','t1','write summary','in_progress','mate1')`,
			),
		);
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const nudge = recipients().find((a) => a.recipientSessionId === "mate1");
		expect(nudge).toBeDefined();
		expect(nudge!.content).toContain("tk1");
		expect(nudge!.content).toContain("update_task");
		expect(nudge!.sourceEventId).toContain("team-hold-nudge:mate1:tk1:");
	});

	it("hold nudge takes priority over the claim nudge and dedupes on the task's updated_at", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "researcher" }, store);
		await db.execute(
			sql.raw(
				`INSERT INTO team_tasks (id, team_id, title, status, assignee_session_id) VALUES ('tk1','t1','write summary','in_progress','mate1')`,
			),
		);
		// claimable work ALSO exists — the held task must still win
		await db.execute(
			sql.raw(`INSERT INTO team_tasks (id, team_id, title) VALUES ('tk2','t1','other')`),
		);
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const mate = recipients().filter((a) => a.recipientSessionId === "mate1");
		expect(mate).toHaveLength(1);
		expect(mate[0].sourceEventId).toContain("team-hold-nudge:");
		// stable hold state → identical sourceEventId on a repeat idle (dedupe key)
		injectMock.mockClear();
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const again = recipients().filter((a) => a.recipientSessionId === "mate1");
		expect(again).toHaveLength(1);
		expect(again[0].sourceEventId).toBe(mate[0].sourceEventId);
	});

	it("marks the member FAILED on session.error and gives the lead the error text", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "researcher" }, store);
		await onTeamSessionEvent(
			"mate1",
			{ type: "session.error", data: { error: "LLM provider 500" } },
			store,
		);
		const rows = (await db.execute(
			sql.raw(`SELECT status FROM team_members WHERE session_id='mate1'`),
		)) as Array<{ status: string }>;
		expect(rows[0].status).toBe("failed");
		const notice = recipients().find((a) => a.recipientSessionId === "lead1");
		expect(notice).toBeDefined();
		expect(notice!.kind).toBe("team-error");
		expect(notice!.content).toContain("FAILED");
		expect(notice!.content).toContain("LLM provider 500");
	});

	it("stops feeding claim nudges to a team whose token budget is exhausted", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, store);
		await db.execute(sql.raw(`UPDATE teams SET token_budget = 100 WHERE id='t1'`));
		// 150 tokens consumed by the member — over the 100 budget.
		await db.execute(
			sql.raw(
				`INSERT INTO session_events (id, session_id, type, data) VALUES ('e1','mate1','agent.llm_usage','{"input_tokens":100,"output_tokens":50}'::jsonb)`,
			),
		);
		// Claimable work exists, but the budget brake wins: lead still notified,
		// NO claim nudge to the teammate.
		await db.execute(
			sql.raw(`INSERT INTO team_tasks (id, team_id, title) VALUES ('tk1','t1','more work')`),
		);
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const r = recipients();
		expect(r.some((a) => a.recipientSessionId === "lead1")).toBe(true);
		expect(r.some((a) => a.recipientSessionId === "mate1")).toBe(false);
	});

	it("never resurrects a shutdown member on its final idle", async () => {
		const { db, store } = await fresh();
		await ensureTeam({ teamId: "t1", leadSessionId: "lead1", projectId: "p1" }, store);
		await addMember({ teamId: "t1", sessionId: "mate1", name: "worker" }, store);
		await db.execute(
			sql.raw(`UPDATE team_members SET status='shutdown' WHERE session_id='mate1'`),
		);
		await onTeamSessionEvent("mate1", { type: "session.status_idle", data: {} }, store);
		const rows = (await db.execute(
			sql.raw(`SELECT status FROM team_members WHERE session_id='mate1'`),
		)) as Array<{ status: string }>;
		expect(rows[0].status).toBe("shutdown"); // terminal — not flipped to idle
		expect(injectMock).not.toHaveBeenCalled(); // and no idle notice for the dead
	});

});
