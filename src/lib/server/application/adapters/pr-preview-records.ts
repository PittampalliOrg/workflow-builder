import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { prPreviews } from "$lib/server/db/schema";
import type {
  PrPreviewAuthority,
  PrPreviewRecord,
  PrPreviewRecordStore,
} from "$lib/server/application/ports";

/** Pipeline states an interrupted run can be resumed from (everything else is terminal). */
export const PR_PREVIEW_RESUMABLE_STATES = ["provisioning", "seeding"] as const;

type Row = typeof prPreviews.$inferSelect;

const FULL_SHA = /^[0-9a-f]{40}$/;
const CATALOG_DIGEST = /^sha256:[0-9a-f]{64}$/;

function parseAuthority(value: unknown): PrPreviewAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const authority = value as Record<string, unknown>;
  if (
    typeof authority.repository !== "string" ||
    authority.baseRef !== "main" ||
    typeof authority.baseSha !== "string" ||
    !FULL_SHA.test(authority.baseSha) ||
    typeof authority.headSha !== "string" ||
    !FULL_SHA.test(authority.headSha) ||
    !Array.isArray(authority.changedPaths) ||
    !authority.changedPaths.every((path) => typeof path === "string") ||
    !Array.isArray(authority.services) ||
    !authority.services.every((service) => typeof service === "string") ||
    typeof authority.platformRepository !== "string" ||
    typeof authority.platformRevision !== "string" ||
    !FULL_SHA.test(authority.platformRevision) ||
    typeof authority.catalogDigest !== "string" ||
    !CATALOG_DIGEST.test(authority.catalogDigest) ||
    typeof authority.requestId !== "string" ||
    typeof authority.requestedAt !== "string"
  ) {
    return null;
  }
  return Object.freeze({
    repository: authority.repository,
    baseRef: "main",
    baseSha: authority.baseSha as never,
    headSha: authority.headSha as never,
    changedPaths: Object.freeze([...(authority.changedPaths as string[])]),
    services: Object.freeze([...(authority.services as string[])]),
    platformRepository: authority.platformRepository,
    platformRevision: authority.platformRevision as never,
    catalogDigest: authority.catalogDigest as `sha256:${string}`,
    requestId: authority.requestId,
    requestedAt: authority.requestedAt,
  });
}

function storedAuthority(
  authority: PrPreviewAuthority | null,
): Record<string, unknown> | null {
  return authority ? JSON.parse(JSON.stringify(authority)) : null;
}

function toRecord(row: Row): PrPreviewRecord {
  return {
    prNumber: row.prNumber,
    alias: row.alias,
    url: row.url,
    state: row.state as PrPreviewRecord["state"],
    headSha: row.headSha,
    services: row.services ?? [],
    authority: parseAuthority(row.authority),
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
      authority: storedAuthority(record.authority),
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
    const { authority, ...rest } = changes;
    const rows = await this.db
      .update(prPreviews)
      .set({
        ...rest,
        ...(authority === undefined
          ? {}
          : { authority: storedAuthority(authority) }),
        updatedAt: new Date(),
      })
      .where(
        and(eq(prPreviews.prNumber, prNumber), eq(prPreviews.ownerGen, gen)),
      )
      .returning({ prNumber: prPreviews.prNumber });
    return rows.length > 0;
  }

  async delete(prNumber: number, gen?: number): Promise<boolean> {
    const rows = await this.db
      .delete(prPreviews)
      .where(
        gen === undefined
          ? eq(prPreviews.prNumber, prNumber)
          : and(
              eq(prPreviews.prNumber, prNumber),
              eq(prPreviews.ownerGen, gen),
            ),
      )
      .returning({ prNumber: prPreviews.prNumber });
    return rows.length > 0;
  }

  async listActive(): Promise<PrPreviewRecord[]> {
    const rows = await this.db
      .select()
      .from(prPreviews)
      .orderBy(desc(prPreviews.updatedAt))
      .limit(50);
    return rows.map(toRecord);
  }

  async claimStale(
    prNumber: number,
    staleMs: number,
  ): Promise<PrPreviewRecord | null> {
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
    return row ? cloneRecord(row) : null;
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
    return cloneRecord(stored);
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

  async delete(prNumber: number, gen?: number): Promise<boolean> {
    const row = this.rows.get(prNumber);
    if (!row || (gen !== undefined && row.gen !== gen)) return false;
    return this.rows.delete(prNumber);
  }

  async listActive(): Promise<PrPreviewRecord[]> {
    return [...this.rows.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 50)
      .map(cloneRecord);
  }

  async claimStale(
    prNumber: number,
    staleMs: number,
  ): Promise<PrPreviewRecord | null> {
    const row = this.rows.get(prNumber);
    if (!row) return null;
    if (!(PR_PREVIEW_RESUMABLE_STATES as readonly string[]).includes(row.state))
      return null;
    if (Date.now() - Date.parse(row.updatedAt) < staleMs) return null;
    row.gen += 1;
    row.updatedAt = new Date().toISOString();
    return cloneRecord(row);
  }
}

function cloneRecord(record: PrPreviewRecord): PrPreviewRecord {
  return {
    ...record,
    services: [...record.services],
    authority: record.authority
      ? {
          ...record.authority,
          services: [...record.authority.services],
          changedPaths: [...record.authority.changedPaths],
        }
      : null,
  };
}
