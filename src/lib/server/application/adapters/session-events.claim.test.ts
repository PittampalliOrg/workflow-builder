/**
 * Crash-safe Agent Teams mailbox contract against real PGlite: lease scoping,
 * stale reclaim, exact-token fencing, and processed_at only after acceptance.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import {
	claimUnraisedTeamEvents,
	completeTeamEventDelivery,
	hasUnprocessedTeamEvents,
	releaseTeamEventDeliveryClaim,
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
			team_delivery_claim_token text,
			team_delivery_claimed_at timestamp,
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
		claimToken?: string | null;
		claimedAt?: Date | null;
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
		INSERT INTO session_events (
			id, session_id, sequence, type, data, processed_at,
			team_delivery_claim_token, team_delivery_claimed_at
		)
		VALUES (${id}, ${input.sessionId ?? SID}, ${seq}, ${input.type ?? "user.message"},
		        ${data}::jsonb, ${input.processedAt ? new Date() : null},
		        ${input.claimToken ?? null}, ${input.claimedAt ?? null})
	`);
	return id;
}

function claim(db: Db, claimToken = "claim-1", staleAfterSeconds = 300) {
	return claimUnraisedTeamEvents(
		{ sessionId: SID, claimToken, staleAfterSeconds },
		db,
	);
}

describe("team mailbox delivery claim", () => {
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
		const h = await seed(db, { origin: "team-error" });

		const claimed = await claim(db);
		expect(claimed.map((c) => c.id)).toEqual([a, f, g, h]);
		expect(claimed[0].data.origin).toBe("teammate-message");
	});

	it("leases without setting processed_at and excludes a fresh second claimant", async () => {
		await seed(db, {});
		expect(await claim(db, "claim-a")).toHaveLength(1);
		expect(await claim(db, "claim-b")).toHaveLength(0);
		const rows = (await db.execute(sql`
			SELECT processed_at, team_delivery_claim_token
			FROM session_events WHERE session_id = ${SID}
		`)) as Array<{
			processed_at: Date | null;
			team_delivery_claim_token: string | null;
		}>;
		expect(rows[0]).toMatchObject({
			processed_at: null,
			team_delivery_claim_token: "claim-a",
		});
		await expect(hasUnprocessedTeamEvents(SID, db)).resolves.toBe(true);
	});

	it("concurrent claims never return overlapping rows", async () => {
		for (let i = 0; i < 6; i++) await seed(db, {});
		const [a, b] = await Promise.all([
			claim(db, "claim-a"),
			claim(db, "claim-b"),
		]);
		const ids = [...a, ...b].map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length); // disjoint
		expect(ids).toHaveLength(6); // nothing lost
	});

	it("is scoped to the requested session", async () => {
		await seed(db, { sessionId: "other-session" });
		expect(await claim(db)).toHaveLength(0);
	});

	it("exact-token release restores rows for a later claim", async () => {
		await seed(db, {});
		await seed(db, {});
		const claimed = await claim(db, "claim-a");
		expect(claimed).toHaveLength(2);
		expect(
			await releaseTeamEventDeliveryClaim(
				{ sessionId: SID, claimToken: "claim-a" },
			db,
			),
		).toBe(2);
		expect(await claim(db, "claim-b")).toHaveLength(2);
	});

	it("stale claims are reclaimed and fence the old owner", async () => {
		await seed(db, {
			claimToken: "crashed-worker",
			claimedAt: new Date("2000-01-01T00:00:00Z"),
		});
		expect(await claim(db, "recovery-worker", 60)).toHaveLength(1);
		expect(
			await completeTeamEventDelivery(
				{ sessionId: SID, claimToken: "crashed-worker" },
				db,
			),
		).toBe(0);
		expect(
			await releaseTeamEventDeliveryClaim(
				{ sessionId: SID, claimToken: "crashed-worker" },
				db,
			),
		).toBe(0);
	});

	it("marks processed only when the exact accepted claim completes", async () => {
		await seed(db, {});
		await seed(db, {});
		await claim(db, "accepted-claim");
		expect(
			await completeTeamEventDelivery(
				{ sessionId: SID, claimToken: "accepted-claim" },
				db,
			),
		).toBe(2);
		expect(await claim(db, "later-claim")).toHaveLength(0);
		const rows = (await db.execute(sql`
			SELECT count(*)::int AS count
			FROM session_events
			WHERE session_id = ${SID}
				AND processed_at IS NOT NULL
				AND team_delivery_claim_token IS NULL
		`)) as Array<{ count: number }>;
		expect(Number(rows[0]?.count)).toBe(2);
		await expect(hasUnprocessedTeamEvents(SID, db)).resolves.toBe(false);
	});

	it("reports only unprocessed team-origin user messages as pending", async () => {
		await seed(db, { origin: "goal-loop" });
		await seed(db, { origin: null });
		await seed(db, { type: "agent.message", origin: "team-error" });
		await expect(hasUnprocessedTeamEvents(SID, db)).resolves.toBe(false);

		await seed(db, { origin: "team-error" });
		await expect(hasUnprocessedTeamEvents(SID, db)).resolves.toBe(true);
	});

	it("a fresh lease cannot be reclaimed before its timeout", async () => {
		await seed(db, {
			claimToken: "active-worker",
			claimedAt: new Date(Date.now() + 60_000),
		});
		expect(await claim(db, "other-worker", 1)).toHaveLength(0);
	});
});
