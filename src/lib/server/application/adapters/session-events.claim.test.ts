/**
 * Claim/unclaim contract for the Agent Teams wake-on-deliver path, against real
 * PGlite. Proves the properties team-delivery.ts relies on: team-origin
 * scoping, ordering, atomicity under concurrent claims, and unclaim rollback.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import {
	claimUnraisedTeamEvents,
	unclaimSessionEvents,
} from "$lib/server/application/adapters/session-events";
import { db as defaultDb } from "$lib/server/db";

type Db = typeof defaultDb;

const SID = "sess-claim-1";

async function freshDb(): Promise<Db> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(`
		CREATE TABLE session_events (
			id text PRIMARY KEY,
			session_id text NOT NULL,
			sequence integer NOT NULL,
			type text NOT NULL,
			data jsonb NOT NULL DEFAULT '{}'::jsonb,
			processed_at timestamp,
			source_event_id text,
			producer_id text,
			producer_epoch text,
			created_at timestamp NOT NULL DEFAULT now()
		)`),
	);
	return db as unknown as Db;
}

let seq = 0;
async function seed(
	db: Db,
	input: {
		type?: string;
		origin?: string | null;
		processedAt?: boolean;
		sessionId?: string;
	} = {},
): Promise<string> {
	seq += 1;
	const id = `ev-${seq}`;
	const data = JSON.stringify(
		input.origin === null
			? { type: input.type ?? "user.message" }
			: {
					type: input.type ?? "user.message",
					origin: input.origin ?? "teammate-message",
					content: [{ type: "text", text: `m${seq}` }],
				},
	);
	await db.execute(sql`
		INSERT INTO session_events (id, session_id, sequence, type, data, processed_at)
		VALUES (${id}, ${input.sessionId ?? SID}, ${seq}, ${input.type ?? "user.message"},
		        ${data}::jsonb, ${input.processedAt ? new Date() : null})
	`);
	return id;
}

describe("claimUnraisedTeamEvents / unclaimSessionEvents", () => {
	let db: Db;
	beforeEach(async () => {
		db = await freshDb();
		seq = 0;
	});

	it("claims only unprocessed team-origin user.message rows, in sequence order", async () => {
		const a = await seed(db, { origin: "teammate-message" });
		await seed(db, { origin: "goal-loop" }); // foreign origin — untouched
		await seed(db, { origin: null }); // no origin — untouched
		await seed(db, { type: "agent.message", origin: "teammate-message" }); // wrong type
		await seed(db, { origin: "team-broadcast", processedAt: true }); // already raised
		const f = await seed(db, { origin: "team-idle" });
		const g = await seed(db, { origin: "team-broadcast" });

		const claimed = await claimUnraisedTeamEvents(SID, db);
		expect(claimed.map((c) => c.id)).toEqual([a, f, g]); // sequence-ordered
		expect(claimed[0].data.origin).toBe("teammate-message");
	});

	it("second claim returns empty (rows are stamped)", async () => {
		await seed(db, {});
		expect(await claimUnraisedTeamEvents(SID, db)).toHaveLength(1);
		expect(await claimUnraisedTeamEvents(SID, db)).toHaveLength(0);
	});

	it("concurrent claims never return overlapping rows", async () => {
		for (let i = 0; i < 6; i++) await seed(db, {});
		const [a, b] = await Promise.all([
			claimUnraisedTeamEvents(SID, db),
			claimUnraisedTeamEvents(SID, db),
		]);
		const ids = [...a, ...b].map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length); // disjoint
		expect(ids).toHaveLength(6); // nothing lost
	});

	it("is scoped to the requested session", async () => {
		await seed(db, { sessionId: "other-session" });
		expect(await claimUnraisedTeamEvents(SID, db)).toHaveLength(0);
	});

	it("unclaim restores rows for a later claim", async () => {
		await seed(db, {});
		await seed(db, {});
		const claimed = await claimUnraisedTeamEvents(SID, db);
		expect(claimed).toHaveLength(2);
		await unclaimSessionEvents(
			SID,
			claimed.map((c) => c.id),
			db,
		);
		expect(await claimUnraisedTeamEvents(SID, db)).toHaveLength(2);
	});

	it("unclaim with empty ids is a no-op", async () => {
		await expect(unclaimSessionEvents(SID, [], db)).resolves.toBeUndefined();
	});
});
