/**
 * recentMessages on the team view (TeamPulse data), against real PGlite:
 * team-origin filtering, recipient-name resolution (incl. the lead), ordering,
 * preview truncation, limit, and inclusion in getTeamView.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";
import { getTeamView } from "$lib/server/teams/team-view";

type Pglite = ReturnType<typeof createPgliteDb>["db"];

const TEAM = "team-x";

async function fresh(): Promise<{ db: Pglite; store: TeamStore }> {
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
	await db.execute(
		sql.raw(
			`CREATE TABLE session_events (id text primary key, session_id text not null, sequence int not null, type text not null, data jsonb not null default '{}'::jsonb, processed_at timestamp, created_at timestamp not null default now())`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_knowledge (id text primary key, team_id text not null, path text not null, type text not null, title text, description text, resource text, tags jsonb not null default '[]'::jsonb, body text not null default '', created_by_session_id text, created_at timestamp not null default now(), updated_at timestamp not null default now(), unique (team_id, path))`,
		),
	);
	const store = new PostgresTeamStore(() => db as never);
	await store.ensureTeam({ teamId: TEAM, leadSessionId: "lead-s", projectId: "p1" });
	await store.addMember({ teamId: TEAM, sessionId: "s-critic", name: "critic" });
	await store.addMember({ teamId: TEAM, sessionId: "s-builder", name: "builder" });
	return { db, store };
}

let seq = 0;
async function seedMsg(
	db: Pglite,
	input: {
		to: string;
		from?: string;
		origin?: string | null;
		text?: string;
		at?: string;
	},
): Promise<void> {
	seq += 1;
	const data = JSON.stringify({
		type: "user.message",
		...(input.origin === null ? {} : { origin: input.origin ?? "teammate-message" }),
		fromAgent: input.from ?? "lead",
		content: [{ type: "text", text: input.text ?? `msg ${seq}` }],
	});
	await db.execute(sql`
		INSERT INTO session_events (id, session_id, sequence, type, data, created_at)
		VALUES (${`ev-${seq}`}, ${input.to}, ${seq}, 'user.message', ${data}::jsonb,
		        ${input.at ?? new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString()})
	`);
}

describe("listRecentTeamMessages / TeamView.recentMessages", () => {
	let db: Pglite;
	let store: TeamStore;
	beforeEach(async () => {
		({ db, store } = await fresh());
		seq = 0;
	});

	it("returns team-origin messages only, newest first, both directions", async () => {
		await seedMsg(db, { to: "s-critic", from: "architect", text: "spec v1" });
		await seedMsg(db, { to: "lead-s", from: "critic", text: "critique back" }); // member→lead
		await seedMsg(db, { to: "s-builder", origin: null, text: "plain user msg" }); // not team-origin
		await seedMsg(db, { to: "s-builder", origin: "team-broadcast", from: "lead", text: "kickoff" });

		const rows = await store.listRecentTeamMessages({ teamId: TEAM });
		expect(rows).toHaveLength(3);
		expect(rows[0].kind).toBe("team-broadcast"); // newest first
		expect(rows[0].to_name).toBe("builder");
		expect(rows[1].to_name).toBe("lead"); // lead resolves as recipient too
		expect(rows[1].from_name).toBe("critic");
		expect(rows[2].preview).toBe("spec v1");
	});

	it("truncates preview at 140 chars and honors limit", async () => {
		await seedMsg(db, { to: "s-critic", text: "x".repeat(400) });
		await seedMsg(db, { to: "s-critic", text: "second" });
		const rows = await store.listRecentTeamMessages({ teamId: TEAM, limit: 1 });
		expect(rows).toHaveLength(1);
		expect(rows[0].preview).toBe("second");
		const all = await store.listRecentTeamMessages({ teamId: TEAM });
		expect(all[1].preview?.length).toBe(140);
	});

	it("getTeamView includes recentMessages with resolved names", async () => {
		await seedMsg(db, { to: "s-critic", from: "lead", text: "hello critic" });
		const view = await getTeamView(TEAM, store);
		expect(view).not.toBeNull();
		expect(view!.recentMessages).toHaveLength(1);
		expect(view!.recentMessages[0]).toMatchObject({
			from: "lead",
			to: "critic",
			toSessionId: "s-critic",
			kind: "teammate-message",
			preview: "hello critic",
		});
	});

	it("scopes to the requested team", async () => {
		await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role)
			VALUES ('m-z', 'other-team', 's-z', 'zed', 'member')
		`);
		await seedMsg(db, { to: "s-z", text: "other team's mail" });
		expect(await store.listRecentTeamMessages({ teamId: TEAM })).toHaveLength(0);
	});
});
