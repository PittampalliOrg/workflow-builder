import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pieceMetadata } from "@/lib/db/schema";
import { parsePieceAuthAll, type PieceAuthConfig } from "@/lib/types/piece-auth";
import { generateId } from "@/lib/utils/id";
import semver from "semver";

const ACTIVEPIECES_PACKAGE_PREFIX = "@activepieces/piece-";

export type PieceMetadataRecord = typeof pieceMetadata.$inferSelect;

export type ListPieceMetadataParams = {
  searchQuery?: string;
  categories?: string[];
  includeHidden?: boolean;
  limit?: number;
};

function expandPieceNameCandidates(name: string): string[] {
  const candidates = new Set([name]);

  if (name.startsWith(ACTIVEPIECES_PACKAGE_PREFIX)) {
    candidates.add(name.slice(ACTIVEPIECES_PACKAGE_PREFIX.length));
  } else {
    candidates.add(`${ACTIVEPIECES_PACKAGE_PREFIX}${name}`);
  }

  return Array.from(candidates);
}

function compareVersionsDesc(a: string, b: string): number {
  const aValid = semver.valid(a);
  const bValid = semver.valid(b);
  if (!aValid && !bValid) {
    return b.localeCompare(a);
  }
  if (!aValid) return 1;
  if (!bValid) return -1;
  return semver.rcompare(a, b);
}

function pickLatestPerName(rows: PieceMetadataRecord[]): PieceMetadataRecord[] {
  const best = new Map<string, PieceMetadataRecord>();
  for (const row of rows) {
    const current = best.get(row.name);
    if (!current) {
      best.set(row.name, row);
      continue;
    }
    const cmp = compareVersionsDesc(row.version, current.version);
    if (cmp < 0) {
      continue;
    }
    if (cmp > 0) {
      best.set(row.name, row);
      continue;
    }
    // Same version (or both invalid): prefer most recently updated.
    if (row.updatedAt > current.updatedAt) {
      best.set(row.name, row);
    }
  }
  return Array.from(best.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function listPieceMetadata(
  params: ListPieceMetadataParams
): Promise<PieceMetadataRecord[]> {
  const conditions = [];

  if (params.searchQuery) {
    conditions.push(
      ilike(pieceMetadata.displayName, `%${params.searchQuery}%`)
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(pieceMetadata)
    .where(whereClause)
    .orderBy(desc(pieceMetadata.updatedAt));

  const candidates =
    !params.categories || params.categories.length === 0
      ? rows
      : (() => {
          const lowerCategories = params.categories.map((c) => c.toLowerCase());
          return rows.filter((row) =>
            (row.categories ?? []).some((category) =>
              lowerCategories.includes(category.toLowerCase())
            )
          );
        })();

  const latest = pickLatestPerName(candidates);
  return latest.slice(0, params.limit ?? latest.length);
}

export async function listAllPieceVersionsByName(
  name: string
): Promise<PieceMetadataRecord[]> {
  const candidateNames = expandPieceNameCandidates(name);
  const rows = await db
    .select()
    .from(pieceMetadata)
    .where(inArray(pieceMetadata.name, candidateNames));

  return rows.sort((a, b) => compareVersionsDesc(a.version, b.version));
}

export async function getLatestPieceMetadataByName(
  name: string
): Promise<PieceMetadataRecord | null> {
  const rows = await listAllPieceVersionsByName(name);
  return rows[0] ?? null;
}

export async function getPieceMetadataByName(
  name: string,
  version?: string
): Promise<PieceMetadataRecord | null> {
  const candidateNames = expandPieceNameCandidates(name);

  if (version) {
    const row = await db.query.pieceMetadata.findFirst({
      where: and(
        inArray(pieceMetadata.name, candidateNames),
        eq(pieceMetadata.version, version)
      ),
    });
    return row ?? null;
  }

  return getLatestPieceMetadataByName(name);
}

export async function getPieceMetadataByNames(
  names: string[]
): Promise<PieceMetadataRecord[]> {
  if (names.length === 0) {
    return [];
  }

  const candidates = names.flatMap((name) => expandPieceNameCandidates(name));
  return db
    .select()
    .from(pieceMetadata)
    .where(inArray(pieceMetadata.name, Array.from(new Set(candidates))));
}

export type UpsertPieceMetadataInput = Omit<
  PieceMetadataRecord,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export async function upsertPieceMetadata(
  record: UpsertPieceMetadataInput
): Promise<PieceMetadataRecord> {
  const existing = await db.query.pieceMetadata.findFirst({
    where: and(
      eq(pieceMetadata.name, record.name),
      eq(pieceMetadata.version, record.version),
      eq(pieceMetadata.platformId, record.platformId)
    ),
  });

  if (existing) {
    const {
      id: _incomingId,
      createdAt: _createdAt,
      ...updatableFields
    } = record;
    const [updated] = await db
      .update(pieceMetadata)
      .set({
        ...updatableFields,
        updatedAt: record.updatedAt ?? new Date(),
      })
      .where(eq(pieceMetadata.id, existing.id))
      .returning();

    return updated;
  }

  const [inserted] = await db
    .insert(pieceMetadata)
    .values({
      ...record,
      id: record.id ?? generateId(),
      createdAt: record.createdAt ?? new Date(),
      updatedAt: record.updatedAt ?? new Date(),
    })
    .returning();

  return inserted;
}

export async function deletePieceMetadataByNameVersion(
  rows: Array<{ name: string; version: string }>
): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  for (const row of rows) {
    await db
      .delete(pieceMetadata)
      .where(
        and(
          eq(pieceMetadata.name, row.name),
          eq(pieceMetadata.version, row.version)
        )
      );
  }
}

export async function countPieceMetadata(): Promise<number> {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pieceMetadata);

  return result?.count ?? 0;
}

/**
 * Get the typed auth configuration for a piece.
 * Returns null if the piece doesn't exist or has no auth config.
 */
export async function getPieceAuthConfig(
  pieceName: string
): Promise<Array<Exclude<PieceAuthConfig, null | undefined>>> {
  const piece = await getPieceMetadataByName(pieceName);
  if (!piece) {
    return [];
  }
  return parsePieceAuthAll(piece.auth);
}
