import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { prPreviews } from "$lib/server/db/schema";
import type { PrPreviewRecord, PrPreviewRecordStore } from "$lib/server/application/ports";

/** Pipeline states an interrupted run can be resumed from (everything else is terminal). */
export const PR_PREVIEW_RESUMABLE_STATES = ["provisioning", "seeding"] as const;

type Row = typeof prPreviews.$inferSelect;

function toRecord(row: Row): PrPreviewRecord {
	return {
		prNumber: row.prNumber,
		alias: row.alias,
		url: row.url,
		state: row.state as PrPreviewRecord["state"],
		headSha: row.headSha,
		services: row.services ?? [],
		error: row.error,
		verify: row.verify ?? null,
		gen: row.ownerGen,
		updatedAt: row.updatedAt.toISOString(),
	};
}

/**
 * Drizzle-backed durable store for D1 PR-preview pipeline records (table
 * `pr_previews`). All pipeline writes are fenced on `owner_gen`: `upsert` and
 * `claimStale` bump it (single guarded UPDATE — atomic in postgres), `patch`
 * CAS-matches it, so at most one pipeline can write a row at any time and a
 * deposed pipeline learns to abort from its first failed patch. No advisory
 * locks: every operation is one self-contained guarded statement.
 */
export class DrizzlePrPreviewRecordStore implements PrPreviewRecordStore {
	private get db() {
		if (!db) throw new Error("Database not configured");
		return db;
	}

	async get(prNumber: number): Promise<PrPreviewRecord | null> {
		const rows = await this.db
			.select()
			.from(prPreviews)
			.where(eq(prPreviews.prNumber, prNumber))
			.limit(1);
		return rows[0] ? toRecord(rows[0]) : null;
	}

	async upsert(
		record: Omit<PrPreviewRecord, "gen" | "updatedAt">,
	): Promise<PrPreviewRecord> {
		const values = {
			prNumber: record.prNumber,
			alias: record.alias,
			url: record.url,
			state: record.state,
			headSha: record.headSha,
			services: record.services,
			error: record.error,
			verify: record.verify,
			ownerGen: 1,
			updatedAt: new Date(),
		};
		const rows = await this.db
			.insert(prPreviews)
			.values(values)
			.onConflictDoUpdate({
				target: prPreviews.prNumber,
				set: {
					...values,
					// Depose whoever holds the row: their next CAS patch fails.
					ownerGen: sql`${prPreviews.ownerGen} + 1`,
				},
			})
			.returning();
		return toRecord(rows[0]);
	}

	async patch(
		prNumber: number,
		gen: number,
		changes: Partial<Omit<PrPreviewRecord, "prNumber" | "gen" | "updatedAt">>,
	): Promise<boolean> {
		const rows = await this.db
			.update(prPreviews)
			.set({ ...changes, updatedAt: new Date() })
			.where(and(eq(prPreviews.prNumber, prNumber), eq(prPreviews.ownerGen, gen)))
			.returning({ prNumber: prPreviews.prNumber });
		return rows.length > 0;
	}

	async delete(prNumber: number): Promise<void> {
		await this.db.delete(prPreviews).where(eq(prPreviews.prNumber, prNumber));
	}

	async listActive(): Promise<PrPreviewRecord[]> {
		const rows = await this.db
			.select()
			.from(prPreviews)
			.orderBy(desc(prPreviews.updatedAt))
			.limit(50);
		return rows.map(toRecord);
	}

	async claimStale(prNumber: number, staleMs: number): Promise<PrPreviewRecord | null> {
		const cutoff = new Date(Date.now() - staleMs);
		const rows = await this.db
			.update(prPreviews)
			.set({ ownerGen: sql`${prPreviews.ownerGen} + 1`, updatedAt: new Date() })
			.where(
				and(
					eq(prPreviews.prNumber, prNumber),
					inArray(prPreviews.state, [...PR_PREVIEW_RESUMABLE_STATES]),
					lt(prPreviews.updatedAt, cutoff),
				),
			)
			.returning();
		return rows[0] ? toRecord(rows[0]) : null;
	}
}

/**
 * In-memory reference implementation of the store contract — used by unit
 * tests and as the executable spec for the fencing semantics (gen bump on
 * upsert/claim, CAS on patch, exactly-one-claim-wins). NOT suitable for
 * production (that is the whole point of #39).
 */
export class InMemoryPrPreviewRecordStore implements PrPreviewRecordStore {
	private readonly rows = new Map<number, PrPreviewRecord>();

	async get(prNumber: number): Promise<PrPreviewRecord | null> {
		const row = this.rows.get(prNumber);
		return row ? { ...row, services: [...row.services] } : null;
	}

	async upsert(
		record: Omit<PrPreviewRecord, "gen" | "updatedAt">,
	): Promise<PrPreviewRecord> {
		const existing = this.rows.get(record.prNumber);
		const stored: PrPreviewRecord = {
			...record,
			services: [...record.services],
			gen: (existing?.gen ?? 0) + 1,
			updatedAt: new Date().toISOString(),
		};
		this.rows.set(record.prNumber, stored);
		return { ...stored, services: [...stored.services] };
	}

	async patch(
		prNumber: number,
		gen: number,
		changes: Partial<Omit<PrPreviewRecord, "prNumber" | "gen" | "updatedAt">>,
	): Promise<boolean> {
		const row = this.rows.get(prNumber);
		if (!row || row.gen !== gen) return false;
		Object.assign(row, changes, { updatedAt: new Date().toISOString() });
		return true;
	}

	async delete(prNumber: number): Promise<void> {
		this.rows.delete(prNumber);
	}

	async listActive(): Promise<PrPreviewRecord[]> {
		return [...this.rows.values()]
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.slice(0, 50)
			.map((r) => ({ ...r, services: [...r.services] }));
	}

	async claimStale(prNumber: number, staleMs: number): Promise<PrPreviewRecord | null> {
		const row = this.rows.get(prNumber);
		if (!row) return null;
		if (!(PR_PREVIEW_RESUMABLE_STATES as readonly string[]).includes(row.state)) return null;
		if (Date.now() - Date.parse(row.updatedAt) < staleMs) return null;
		row.gen += 1;
		row.updatedAt = new Date().toISOString();
		return { ...row, services: [...row.services] };
	}
}
