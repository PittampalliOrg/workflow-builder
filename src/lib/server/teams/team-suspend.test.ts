/**
 * Suspend-on-idle tick against real PGlite (candidate SQL + status writes) with
 * the kube patch mocked. Pins: threshold/lead/terminal gating, claimable-work
 * skip, status written only AFTER a successful patch, "missing" CR skip, and
 * tick idempotency via the deterministic audit sourceEventId.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";
import { runTeamSuspendTick, type TeamSuspendDeps } from "$lib/server/teams/team-suspend";

type Pglite = ReturnType<typeof createPgliteDb>["db"];

async function fresh(): Promise<{ db: Pglite; store: TeamStore }> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(
			`CREATE TABLE team_members (id text primary key, team_id text not null, session_id text unique not null, agent_slug text, name text not null, role text default 'member', model text, status text default 'working', plan_mode_required boolean default false, joined_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_tasks (id text primary key, team_id text not null, title text not null, description text, status text default 'pending', assignee_session_id text, depends_on jsonb default '[]'::jsonb, created_by_session_id text, created_at timestamp default now(), updated_at timestamp default now(), completed_at timestamp)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE sessions (id text primary key, status text default 'idle', dapr_instance_id text, runtime_sandbox_name text, last_event_at timestamp)`,
		),
	);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

async function seedMember(
	db: Pglite,
	input: {
		sessionId: string;
		role?: string;
		memberStatus?: string;
		sessionStatus?: string;
		daprInstanceId?: string | null;
		idleForSeconds?: number;
		sandboxName?: string | null;
	},
): Promise<void> {
	await db.execute(sql`
		INSERT INTO team_members (id, team_id, session_id, name, role, status, updated_at)
		VALUES (${`m-${input.sessionId}`}, 't1', ${input.sessionId}, ${input.sessionId},
		        ${input.role ?? "member"}, ${input.memberStatus ?? "idle"},
		        now() - make_interval(secs => ${input.idleForSeconds ?? 3600}))
	`);
	await db.execute(sql`
		INSERT INTO sessions (id, status, dapr_instance_id, runtime_sandbox_name, last_event_at)
		VALUES (${input.sessionId}, ${input.sessionStatus ?? "idle"},
		        ${input.daprInstanceId === undefined ? "wf-1" : input.daprInstanceId},
		        ${input.sandboxName === undefined ? `agent-host-${input.sessionId}` : input.sandboxName},
		        now() - make_interval(secs => ${input.idleForSeconds ?? 3600}))
	`);
}

function makeDeps(result: "patched" | "missing" | Error = "patched") {
	const appended: Array<{ sessionId: string; sourceEventId?: string | null }> = [];
	const deps: TeamSuspendDeps = {
		suspendSessionSandbox: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		}),
		appendSessionEvent: vi.fn(async (sessionId, event) => {
			appended.push({ sessionId, sourceEventId: event.sourceEventId });
			return {};
		}),
	};
	return { deps, appended };
}

async function memberStatus(db: Pglite, sessionId: string): Promise<string> {
	const r = (await db.execute(
		sql`SELECT status FROM team_members WHERE session_id = ${sessionId}`,
	)) as Array<{ status: string }>;
	return r[0]?.status ?? "<gone>";
}

describe("runTeamSuspendTick", () => {
	beforeEach(() => {
		process.env.TEAM_SUSPEND_ENABLED = "true";
		process.env.TEAM_SUSPEND_IDLE_SECONDS = "900";
	});
	afterEach(() => {
		delete process.env.TEAM_SUSPEND_ENABLED;
		delete process.env.TEAM_SUSPEND_IDLE_SECONDS;
	});

	it("does nothing when the gate is off", async () => {
		process.env.TEAM_SUSPEND_ENABLED = "false";
		const { deps } = makeDeps();
		// A poisoned store proves the gate short-circuits before any query.
		const store = new Proxy({} as TeamStore, {
			get: () => {
				throw new Error("store must not be touched");
			},
		});
		expect(await runTeamSuspendTick(store, deps)).toEqual({ suspended: 0, skipped: 0 });
	});

	it("suspends an idle-past-threshold teammate: patch, then status, then audit", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps, appended } = makeDeps();

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 1, skipped: 0 });
		expect(deps.suspendSessionSandbox).toHaveBeenCalledWith("agent-host-s1");
		expect(await memberStatus(db, "s1")).toBe("suspended");
		expect(appended[0].sourceEventId).toMatch(/^host-suspend:s1:/);
	});

	it("skips: under threshold, lead, terminal session, unspawned session", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "fresh", idleForSeconds: 60 });
		await seedMember(db, { sessionId: "lead1", role: "lead", idleForSeconds: 3600 });
		await seedMember(db, { sessionId: "dead", sessionStatus: "terminated", idleForSeconds: 3600 });
		await seedMember(db, { sessionId: "unspawned", daprInstanceId: null, idleForSeconds: 3600 });
		const { deps } = makeDeps();

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 0 }); // none even candidates
		expect(deps.suspendSessionSandbox).not.toHaveBeenCalled();
	});

	it("skips a member whose team has claimable work (nudge path owns it)", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		await db.execute(
			sql.raw(`INSERT INTO team_tasks (id, team_id, title) VALUES ('t-1','t1','todo')`),
		);
		const { deps } = makeDeps();

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
		expect(deps.suspendSessionSandbox).not.toHaveBeenCalled();
		expect(await memberStatus(db, "s1")).toBe("idle");
	});

	it("missing CR: skips without writing suspended", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps("missing");

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
		expect(await memberStatus(db, "s1")).toBe("idle");
	});

	it("patch failure: skips, leaves status idle for the next tick", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps(new Error("kube down"));

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
		expect(await memberStatus(db, "s1")).toBe("idle");
	});

	it("second tick is a no-op (suspended members are not candidates)", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps();
		await runTeamSuspendTick(store, deps);
		const again = await runTeamSuspendTick(store, deps);
		expect(again).toEqual({ suspended: 0, skipped: 0 });
		expect(deps.suspendSessionSandbox).toHaveBeenCalledTimes(1);
		expect(await memberStatus(db, "s1")).toBe("suspended");
	});

	it("uses the session's persisted runtime_sandbox_name when present", async () => {
		const { db, store } = await fresh();
		await seedMember(db, {
			sessionId: "s1",
			idleForSeconds: 3600,
			sandboxName: "agent-host-custom-name",
		});
		const { deps } = makeDeps();
		await runTeamSuspendTick(store, deps);
		expect(deps.suspendSessionSandbox).toHaveBeenCalledWith("agent-host-custom-name");
	});
});
