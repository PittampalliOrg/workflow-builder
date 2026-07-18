/**
 * Client-side join between the PR-preview lane (`getPrPreviews`) and the
 * promotion receipts carried by the drift overview (`getPreviewDriftOverview`).
 * When a promotion receipt from a retained/lifecycle preview points at a PR
 * that ALSO has a PR preview (same PR number, or a PR preview at the same head
 * SHA), the PR-preview row and any receipt link can badge "preview exists for
 * this code" and link back to the originating preview. Pure functions — no
 * server reads.
 */

import type {
	PrPreviewListItem,
	PreviewDriftEntry,
	PreviewPromotionReceiptSummary,
	VclusterPreviewSummary
} from '$lib/types/dev-previews';

/** Minimum overlapping hex length before two SHAs are considered the same commit. */
const MIN_SHA_PREFIX = 7;

/** Prefix-tolerant commit comparison (receipts may store short SHAs). */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
	const left = (a ?? '').trim().toLowerCase();
	const right = (b ?? '').trim().toLowerCase();
	if (left.length < MIN_SHA_PREFIX || right.length < MIN_SHA_PREFIX) return false;
	if (!/^[0-9a-f]+$/.test(left) || !/^[0-9a-f]+$/.test(right)) return false;
	return left.startsWith(right) || right.startsWith(left);
}

export type PreviewDedupeMatch = {
	/** The retained/lifecycle preview that already runs this code. */
	previewName: string;
	lifecycle: PreviewDriftEntry['lifecycle'];
	stage: PreviewDriftEntry['stage'];
	matchedBy: 'pr-number' | 'head-sha';
	receipt: PreviewPromotionReceiptSummary;
	/** Browsable URL of the matched preview when the fleet list knows it. */
	previewUrl: string | null;
};

function previewUrlFor(
	name: string,
	previews: VclusterPreviewSummary[] | undefined
): string | null {
	return previews?.find((preview) => preview.name === name)?.url ?? null;
}

function matchReceiptToItem(
	receipt: PreviewPromotionReceiptSummary,
	item: PrPreviewListItem
): 'pr-number' | 'head-sha' | null {
	if (receipt.prNumber === item.prNumber) return 'pr-number';
	if (shaMatches(item.headSha, receipt.commitSha)) return 'head-sha';
	return null;
}

/**
 * Map of PR number → the preview whose promotion receipt covers that PR's
 * code. Retained previews win over ephemeral ones when both match; a drift
 * entry never matches its own PR preview (`entry.name === item.alias`).
 */
export function buildPrPreviewDedupeIndex(
	prItems: PrPreviewListItem[],
	driftEntries: PreviewDriftEntry[],
	previews?: VclusterPreviewSummary[]
): Map<number, PreviewDedupeMatch> {
	const index = new Map<number, PreviewDedupeMatch>();
	if (prItems.length === 0 || driftEntries.length === 0) return index;
	// Retained (long-lived) previews first so they win ties.
	const orderedEntries = [...driftEntries].sort((a, b) => {
		const aRetained = a.lifecycle === 'retained' ? 0 : 1;
		const bRetained = b.lifecycle === 'retained' ? 0 : 1;
		return aRetained - bRetained;
	});
	for (const item of prItems) {
		for (const entry of orderedEntries) {
			if (entry.name === item.alias) continue; // the PR preview itself
			let found: PreviewDedupeMatch | null = null;
			for (const receipt of entry.receipts) {
				const matchedBy = matchReceiptToItem(receipt, item);
				if (!matchedBy) continue;
				found = {
					previewName: entry.name,
					lifecycle: entry.lifecycle,
					stage: entry.stage,
					matchedBy,
					receipt,
					previewUrl: previewUrlFor(entry.name, previews)
				};
				// PR-number matches are stronger than SHA-prefix matches.
				if (matchedBy === 'pr-number') break;
			}
			if (found) {
				index.set(item.prNumber, found);
				break;
			}
		}
	}
	return index;
}

/**
 * Reverse direction for receipt-link surfaces (environment cards): given one
 * promotion receipt, the PR preview that already runs the same code — by PR
 * number (the receipt's PR carries the preview label lane) or head SHA.
 */
export function findPrPreviewForReceipt(
	receipt: PreviewPromotionReceiptSummary,
	prItems: PrPreviewListItem[]
): { item: PrPreviewListItem; matchedBy: 'pr-number' | 'head-sha' } | null {
	let shaMatch: { item: PrPreviewListItem; matchedBy: 'head-sha' } | null = null;
	for (const item of prItems) {
		const matchedBy = matchReceiptToItem(receipt, item);
		if (matchedBy === 'pr-number') return { item, matchedBy };
		if (matchedBy === 'head-sha' && !shaMatch) shaMatch = { item, matchedBy };
	}
	return shaMatch;
}

/** Tooltip copy for the dedupe badge. */
export function describeDedupeMatch(match: PreviewDedupeMatch): string {
	const kind = match.lifecycle === 'retained' ? 'Retained preview' : 'Preview';
	const how =
		match.matchedBy === 'pr-number'
			? `promotion receipt PR #${match.receipt.prNumber}`
			: `promotion receipt commit ${match.receipt.commitSha.slice(0, 10)}`;
	return `${kind} “${match.previewName}” already runs this code (${how}). A PR preview here would duplicate it.`;
}
