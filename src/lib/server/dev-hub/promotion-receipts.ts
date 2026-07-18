/**
 * Per-preview promotion-receipt list read for the Dev-hub drift overview.
 *
 * The existing receipt store adapter
 * (`application/adapters/preview-source-promotion-receipts.ts`) only exposes
 * artifact/scope-keyed point reads and sits behind the gate-protected preview
 * surface, so this NEW module queries the same durable table directly (read
 * only — no schema changes) via the shared drizzle client.
 */
import { desc, inArray } from "drizzle-orm";

import { db as defaultDb } from "$lib/server/db";
import { previewSourcePromotionReceipts } from "$lib/server/db/schema";
import type { PreviewPromotionReceiptSummary } from "$lib/types/dev-previews";

type Database = typeof defaultDb;

export type PreviewReceiptListing = {
	/** Newest-first receipt summaries per preview name. */
	receiptsByPreview: Map<string, PreviewPromotionReceiptSummary[]>;
	/** Execution ids that produced receipts, per preview name. */
	executionIdsByPreview: Map<string, string[]>;
};

const MAX_RECEIPTS_PER_PREVIEW = 10;

/**
 * List promotion receipts for a set of preview names, newest first, capped at
 * {@link MAX_RECEIPTS_PER_PREVIEW} each. Degrades to empty maps when the
 * database is unavailable (the drift overview stays renderable).
 */
export async function listPromotionReceiptsForPreviews(
	previewNames: readonly string[],
	database: Database = defaultDb,
): Promise<PreviewReceiptListing> {
	const receiptsByPreview = new Map<string, PreviewPromotionReceiptSummary[]>();
	const executionIdsByPreview = new Map<string, string[]>();
	const names = [...new Set(previewNames)].filter(Boolean);
	if (names.length === 0 || !database) {
		return { receiptsByPreview, executionIdsByPreview };
	}

	let rows: Array<{
		previewName: string;
		executionId: string;
		pullRequestNumber: number;
		prUrl: string;
		commitSha: string;
		createdAt: Date | string;
	}>;
	try {
		rows = await database
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
			.limit(names.length * MAX_RECEIPTS_PER_PREVIEW);
	} catch {
		return { receiptsByPreview, executionIdsByPreview };
	}

	for (const row of rows) {
		const receipts = receiptsByPreview.get(row.previewName) ?? [];
		if (receipts.length < MAX_RECEIPTS_PER_PREVIEW) {
			receipts.push({
				prNumber: row.pullRequestNumber,
				prUrl: row.prUrl,
				commitSha: row.commitSha,
				createdAt:
					row.createdAt instanceof Date
						? row.createdAt.toISOString()
						: new Date(row.createdAt).toISOString(),
			});
			receiptsByPreview.set(row.previewName, receipts);
		}
		const executions = executionIdsByPreview.get(row.previewName) ?? [];
		if (!executions.includes(row.executionId)) {
			executions.push(row.executionId);
			executionIdsByPreview.set(row.previewName, executions);
		}
	}
	return { receiptsByPreview, executionIdsByPreview };
}
