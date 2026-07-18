import { createHash } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  ImmutableGitSha,
  PreviewSourcePromotionReceipt,
  PreviewSourcePromotionReceiptInput,
  PreviewSourcePromotionReceiptListItem,
  PreviewSourcePromotionReceiptListingPort,
  PreviewSourcePromotionReceiptScope,
  PreviewSourcePromotionReceiptStorePort,
} from "$lib/server/application/ports";
import { db as defaultDb } from "$lib/server/db";
import {
  previewControlArtifacts,
  previewSourcePromotionReceipts,
} from "$lib/server/db/schema";

type Database = typeof defaultDb;

/** Physical-only append-only proof of a verified source promotion. */
export class PostgresPreviewSourcePromotionReceiptStore
  implements
    PreviewSourcePromotionReceiptStorePort,
    PreviewSourcePromotionReceiptListingPort
{
  constructor(private readonly database: Database = defaultDb) {}

  /** Newest-first receipts across `previewNames` (Dev-hub drift overview). */
  async listRecentByPreview(
    input: Readonly<{
      previewNames: readonly string[];
      limitPerPreview: number;
    }>,
  ): Promise<readonly PreviewSourcePromotionReceiptListItem[]> {
    const names = [...new Set(input.previewNames)].filter(Boolean);
    if (names.length === 0) return [];
    const rows = await this.database
      .select({
        previewName: previewSourcePromotionReceipts.previewName,
        executionId: previewSourcePromotionReceipts.executionId,
        pullRequestNumber: previewSourcePromotionReceipts.pullRequestNumber,
        prUrl: previewSourcePromotionReceipts.prUrl,
        commitSha: previewSourcePromotionReceipts.commitSha,
        createdAt: previewSourcePromotionReceipts.createdAt,
      })
      .from(previewSourcePromotionReceipts)
      .where(inArray(previewSourcePromotionReceipts.previewName, names))
      .orderBy(desc(previewSourcePromotionReceipts.createdAt))
      .limit(names.length * input.limitPerPreview);
    return rows.map((row) => ({
      previewName: row.previewName,
      executionId: row.executionId,
      pullRequestNumber: row.pullRequestNumber,
      prUrl: row.prUrl,
      commitSha: row.commitSha,
      createdAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : new Date(row.createdAt).toISOString(),
    }));
  }

  async put(
    input: PreviewSourcePromotionReceiptInput,
  ): Promise<PreviewSourcePromotionReceipt> {
    const prepared = prepare(input);
    await this.assertArtifact(prepared);
    const existing = await this.getByArtifact(prepared.artifactId);
    if (existing) return assertSame(existing, prepared);

    await this.database
      .insert(previewSourcePromotionReceipts)
      .values({
        receiptId: prepared.receiptId,
        artifactId: prepared.artifactId,
        previewName: prepared.previewName,
        environmentRequestId: prepared.requestId,
        executionId: prepared.executionId,
        platformRevision: prepared.platformRevision,
        sourceRevision: prepared.sourceRevision,
        catalogDigest: prepared.catalogDigest,
        repository: prepared.repository,
        baseBranch: prepared.baseBranch,
        baseSha: prepared.baseSha,
        branch: prepared.branch,
        commitSha: prepared.commitSha,
        prUrl: prepared.prUrl,
        pullRequestNumber: prepared.pullRequestNumber,
        draft: true,
        services: [...prepared.services],
        changedPaths: [...prepared.changedPaths],
      })
      .onConflictDoNothing();

    const stored = await this.getByArtifact(prepared.artifactId);
    if (!stored) throw new Error("source promotion receipt insert was not observable");
    return assertSame(stored, prepared);
  }

  async getByArtifact(
    artifactId: string,
  ): Promise<PreviewSourcePromotionReceipt | null> {
    const [row] = await this.database
      .select()
      .from(previewSourcePromotionReceipts)
      .where(eq(previewSourcePromotionReceipts.artifactId, artifactId))
      .limit(1);
    return row ? mapReceipt(row) : null;
  }

  async getScoped(
    input: PreviewSourcePromotionReceiptScope & Readonly<{ receiptId: string }>,
  ): Promise<PreviewSourcePromotionReceipt | null> {
    const [row] = await this.database
      .select()
      .from(previewSourcePromotionReceipts)
      .where(
        and(
          eq(previewSourcePromotionReceipts.receiptId, input.receiptId),
          ...scopeConditions(input),
        ),
      )
      .limit(1);
    return row ? mapReceipt(row) : null;
  }

  async getLatestForExecution(
    input: PreviewSourcePromotionReceiptScope,
  ): Promise<PreviewSourcePromotionReceipt | null> {
    const [row] = await this.database
      .select()
      .from(previewSourcePromotionReceipts)
      .where(and(...scopeConditions(input)))
      .orderBy(
        desc(previewSourcePromotionReceipts.createdAt),
        desc(previewSourcePromotionReceipts.receiptId),
      )
      .limit(1);
    return row ? mapReceipt(row) : null;
  }

  private async assertArtifact(
    input: PreviewSourcePromotionReceipt,
  ): Promise<void> {
    const [artifact] = await this.database
      .select({
        services: previewControlArtifacts.services,
      })
      .from(previewControlArtifacts)
      .where(
        and(
          eq(previewControlArtifacts.id, input.artifactId),
          eq(previewControlArtifacts.previewName, input.previewName),
          eq(
            previewControlArtifacts.environmentRequestId,
            input.requestId,
          ),
          eq(previewControlArtifacts.executionId, input.executionId),
          eq(
            previewControlArtifacts.platformRevision,
            input.platformRevision,
          ),
          eq(previewControlArtifacts.sourceRevision, input.sourceRevision),
          eq(previewControlArtifacts.catalogDigest, input.catalogDigest),
        ),
      )
      .limit(1);
    const captured = new Set((artifact?.services ?? []) as string[]);
    if (!artifact || input.services.some((service) => !captured.has(service))) {
      throw new Error("source promotion receipt does not match its imported artifact");
    }
  }
}

function scopeConditions(input: PreviewSourcePromotionReceiptScope) {
  return [
    eq(previewSourcePromotionReceipts.previewName, input.previewName),
    eq(previewSourcePromotionReceipts.environmentRequestId, input.requestId),
    eq(previewSourcePromotionReceipts.executionId, input.executionId),
    eq(
      previewSourcePromotionReceipts.platformRevision,
      input.platformRevision,
    ),
    eq(previewSourcePromotionReceipts.sourceRevision, input.sourceRevision),
    eq(previewSourcePromotionReceipts.catalogDigest, input.catalogDigest),
    eq(previewSourcePromotionReceipts.repository, input.repository),
    eq(previewSourcePromotionReceipts.baseBranch, input.baseBranch),
  ] as const;
}

function prepare(
  input: PreviewSourcePromotionReceiptInput,
): PreviewSourcePromotionReceipt {
  const content: PreviewSourcePromotionReceiptInput = Object.freeze({
    ...input,
    services: Object.freeze([...new Set(input.services)].sort()),
    changedPaths: Object.freeze([...new Set(input.changedPaths)].sort()),
    draft: true,
  });
  const receiptId = `pspr_${createHash("sha256")
    .update(stableJson(content))
    .digest("hex")}`;
  return Object.freeze({ ...content, receiptId, createdAt: "" });
}

function mapReceipt(
  row: typeof previewSourcePromotionReceipts.$inferSelect,
): PreviewSourcePromotionReceipt {
  return Object.freeze({
    receiptId: row.receiptId,
    artifactId: row.artifactId,
    previewName: row.previewName,
    requestId: row.environmentRequestId,
    executionId: row.executionId,
    platformRevision: row.platformRevision as ImmutableGitSha,
    sourceRevision: row.sourceRevision as ImmutableGitSha,
    catalogDigest: row.catalogDigest as `sha256:${string}`,
    repository: row.repository,
    baseBranch: row.baseBranch,
    baseSha: row.baseSha as ImmutableGitSha,
    branch: row.branch,
    commitSha: row.commitSha as ImmutableGitSha,
    prUrl: row.prUrl,
    pullRequestNumber: row.pullRequestNumber,
    draft: true,
    services: Object.freeze([...(row.services as string[])]),
    changedPaths: Object.freeze([...(row.changedPaths as string[])]),
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : new Date(row.createdAt).toISOString(),
  });
}

function assertSame(
  stored: PreviewSourcePromotionReceipt,
  prepared: PreviewSourcePromotionReceipt,
): PreviewSourcePromotionReceipt {
  const { createdAt: _storedCreatedAt, ...storedContent } = stored;
  const { createdAt: _preparedCreatedAt, ...preparedContent } = prepared;
  if (stableJson(storedContent) !== stableJson(preparedContent)) {
    throw new Error(
      "immutable source promotion artifact was replayed with different proof",
    );
  }
  return stored;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
