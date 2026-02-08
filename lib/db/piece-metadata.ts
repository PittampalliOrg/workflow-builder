import { and, desc, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pieceMetadata } from "@/lib/db/schema";
import { type PieceAuthConfig, parsePieceAuth } from "@/lib/types/piece-auth";
import { generateId } from "@/lib/utils/id";

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
    .orderBy(desc(pieceMetadata.updatedAt))
    .limit(params.limit ?? 500);

  if (!params.categories || params.categories.length === 0) {
    return rows;
  }

  const lowerCategories = params.categories.map((c) => c.toLowerCase());
  return rows.filter((row) =>
    (row.categories ?? []).some((category) =>
      lowerCategories.includes(category.toLowerCase())
    )
  );
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

  const rows = await db
    .select()
    .from(pieceMetadata)
    .where(inArray(pieceMetadata.name, candidateNames))
    .orderBy(desc(pieceMetadata.updatedAt))
    .limit(1);

  return rows[0] ?? null;
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
  const platformCondition =
    record.platformId === null
      ? isNull(pieceMetadata.platformId)
      : eq(pieceMetadata.platformId, record.platformId);

  const existing = await db.query.pieceMetadata.findFirst({
    where: and(
      eq(pieceMetadata.name, record.name),
      eq(pieceMetadata.version, record.version),
      platformCondition
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
): Promise<PieceAuthConfig> {
  const piece = await getPieceMetadataByName(pieceName);
  if (!piece) {
    return null;
  }
  return parsePieceAuth(piece.auth);
}
