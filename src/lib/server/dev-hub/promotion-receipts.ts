/**
 * Per-preview promotion-receipt list read for the Dev-hub drift overview — a
 * thin seam over the application surface
 * (`getApplicationAdapters().vclusterPreviews.listPromotionReceipts`). The
 * durable-table read itself lives in the receipts adapter behind
 * `PreviewSourcePromotionReceiptListingPort`, so persistence stays inside
 * `application/adapters` (dependency-cruiser `db-only-in-adapters`).
 */
import { getApplicationAdapters } from "$lib/server/application";
import type { PreviewReceiptListing } from "$lib/server/application/vcluster-previews";

export type { PreviewReceiptListing } from "$lib/server/application/vcluster-previews";

/**
 * List promotion receipts for a set of preview names, newest first, capped per
 * preview. Degrades to empty maps when the database is unavailable (the drift
 * overview stays renderable).
 */
export async function listPromotionReceiptsForPreviews(
	previewNames: readonly string[],
): Promise<PreviewReceiptListing> {
	return getApplicationAdapters().vclusterPreviews.listPromotionReceipts(
		previewNames,
	);
}
