/**
 * Team live activity — real SQL against PGlite. Pins: latest-event-per-member
 * (LATERAL), event-type filtering (only story-telling types), team scoping,
 * and the merged stream ordering.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";

type Handle = ReturnType<typeof createPgliteDb>["db"];

async function fresh(): Promise<{ db: Handle; store: TeamStore }> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(
			`CREATE TABLE team_members (id text primary key, team_id text not null, session_id text unique not null, agent_slug text, name text not null, role text default 'member', model text, status text default 'working', plan_mode_required boolean default false, joined_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE session_events (id text primary key, session_id text not null, type text not null, data jsonb not null default '{}'::jsonb, created_at timestamp not null default now())`,
		),
	);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

async function seedMember(db: Handle, teamId: string, name: string, sessionId: string) {
	await db.execute(
		sql.raw(
			`INSERT INTO team_members (id, team_id, session_id, name) VALUES ('m-${name}', '${teamId}', '${sessionId}', '${name}')`,
		),
	);
}
async function seedEvent(
	db: Handle,
	id: string,
	sessionId: string,
	type: string,
	data: Record<string, unknown>,
	at: string,
) {
	await db.execute(
		sql.raw(
			`INSERT INTO session_events (id, session_id, type, data, created_at) VALUES ('${id}', '${sessionId}', '${type}', '${JSON.stringify(data).replace(/'/g, "''")}'::jsonb, '${at}')`,
		),
	);
}

describe("getTeamLiveActivity", () => {
	let db: Handle;
	let store: TeamStore;
	beforeEach(async () => {
		({ db, store } = await fresh());
	});

	it("returns the LATEST story event per member and tolerates event-less members", async () => {
		await seedMember(db, "t1", "researcher", "s1");
		await seedMember(db, "t1", "writer", "s2");
		await seedEvent(db, "e1", "s1", "agent.tool_use", { name: "Bash" }, "2026-07-11 10:00:00");
		await seedEvent(
			db,
			"e2",
			"s1",
			"mcp.tool_call",
			{ tool_name: "wfb_goal_claim_task" },
			"2026-07-11 10:01:00",
		);
		// A non-story event AFTER the story event must not win.
		await seedEvent(db, "e3", "s1", "agent.llm_usage", { input_tokens: 5 }, "2026-07-11 10:02:00");

		const live = await store.getTeamLiveActivity({ teamId: "t1" });
		const researcher = live.members.find((m) => m.name === "researcher");
		expect(researcher?.event_type).toBe("mcp.tool_call");
		expect(researcher?.tool_name).toBe("wfb_goal_claim_task");
		const writer = live.members.find((m) => m.name === "writer");
		expect(writer?.event_type).toBeNull(); // no events yet — still listed
	});

	it("merges the stream newest-first, team-scoped, with previews", async () => {
		await seedMember(db, "t1", "a", "s1");
		await seedMember(db, "t2", "other", "sX");
		await seedEvent(
			db,
			"e1",
			"s1",
			"user.message",
			{ origin: "team-broadcast", fromAgent: "lead", content: [{ type: "text", text: "Kickoff now" }] },
			"2026-07-11 10:00:00",
		);
		await seedEvent(db, "e2", "s1", "agent.message", { content: [{ type: "text", text: "On it" }] }, "2026-07-11 10:01:00");
		await seedEvent(db, "eX", "sX", "agent.message", { content: [{ type: "text", text: "other team" }] }, "2026-07-11 10:02:00");

		const live = await store.getTeamLiveActivity({ teamId: "t1", streamLimit: 10 });
		expect(live.stream.map((e) => e.event_type)).toEqual(["agent.message", "user.message"]);
		expect(live.stream[0].preview).toBe("On it");
		expect(live.stream[1].origin).toBe("team-broadcast");
		expect(live.stream[1].from_agent).toBe("lead");
	});
});
