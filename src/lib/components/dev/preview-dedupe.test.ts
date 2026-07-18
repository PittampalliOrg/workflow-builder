import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	buildPrPreviewDedupeIndex,
	describeDedupeMatch,
	findPrPreviewForReceipt,
	shaMatches
} from './preview-dedupe';
import type {
	PreviewDriftEntry,
	PreviewPromotionReceiptSummary,
	PrPreviewListItem,
	VclusterPreviewSummary
} from '$lib/types/dev-previews';

function prItem(overrides: Partial<PrPreviewListItem> = {}): PrPreviewListItem {
	return {
		prNumber: 101,
		alias: 'pr-101',
		url: 'https://pr-101.previews.example',
		prUrl: 'https://github.com/o/r/pull/101',
		state: 'ready',
		headSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
		services: ['workflow-builder'],
		error: null,
		verify: null,
		updatedAt: '2026-07-17T10:00:00Z',
		...overrides
	};
}

function receipt(
	overrides: Partial<PreviewPromotionReceiptSummary> = {}
): PreviewPromotionReceiptSummary {
	return {
		prNumber: 101,
		prUrl: 'https://github.com/o/r/pull/101',
		commitSha: 'aaaabbbbccccddddeeeeffff0000111122223333',
		createdAt: '2026-07-17T09:00:00Z',
		...overrides
	};
}

function driftEntry(overrides: Partial<PreviewDriftEntry> = {}): PreviewDriftEntry {
	return {
		name: 'agent-alpha',
		phase: 'ready',
		state: 'hot',
		lifecycle: 'retained',
		stage: 'promoted',
		syncGeneration: null,
		services: [],
		receipts: [receipt()],
		...overrides
	};
}

describe('shaMatches', () => {
	it('accepts full and prefix hex matches of at least 7 chars', () => {
		expect(shaMatches('aaaabbbbcccc', 'aaaabbbbccccddddeeee')).toBe(true);
		expect(shaMatches('AAAABBBBCCCC', 'aaaabbbbcccc')).toBe(true);
		expect(shaMatches('aaaabb', 'aaaabbbbcccc')).toBe(false); // too short
		expect(shaMatches('not-hex-value', 'aaaabbbbcccc')).toBe(false);
		expect(shaMatches(null, 'aaaabbbbcccc')).toBe(false);
	});
});

describe('buildPrPreviewDedupeIndex', () => {
	it('matches a PR-preview row to a receipt by PR number', () => {
		const index = buildPrPreviewDedupeIndex([prItem()], [driftEntry()]);
		const match = index.get(101);
		expect(match?.previewName).toBe('agent-alpha');
		expect(match?.matchedBy).toBe('pr-number');
		expect(match?.lifecycle).toBe('retained');
	});

	it('matches by head SHA when the PR numbers differ', () => {
		const index = buildPrPreviewDedupeIndex(
			[prItem({ prNumber: 999, prUrl: 'https://github.com/o/r/pull/999' })],
			[driftEntry({ receipts: [receipt({ prNumber: 101, commitSha: 'aaaabbbbccccdddd' })] })]
		);
		expect(index.get(999)?.matchedBy).toBe('head-sha');
	});

	it('never matches the drift entry that IS the PR preview itself', () => {
		const index = buildPrPreviewDedupeIndex(
			[prItem({ alias: 'pr-101' })],
			[driftEntry({ name: 'pr-101' })]
		);
		expect(index.size).toBe(0);
	});

	it('prefers retained previews over ephemeral ones', () => {
		const index = buildPrPreviewDedupeIndex(
			[prItem()],
			[
				driftEntry({ name: 'ephemeral-one', lifecycle: 'ephemeral' }),
				driftEntry({ name: 'retained-one', lifecycle: 'retained' })
			]
		);
		expect(index.get(101)?.previewName).toBe('retained-one');
	});

	it('resolves the matched preview URL from the fleet list', () => {
		const previews = [{ name: 'agent-alpha', url: 'https://agent-alpha.previews.example' }];
		const index = buildPrPreviewDedupeIndex(
			[prItem()],
			[driftEntry()],
			previews as unknown as VclusterPreviewSummary[]
		);
		expect(index.get(101)?.previewUrl).toBe('https://agent-alpha.previews.example');
	});

	it('returns an empty index when nothing joins', () => {
		expect(buildPrPreviewDedupeIndex([], [driftEntry()]).size).toBe(0);
		expect(buildPrPreviewDedupeIndex([prItem()], []).size).toBe(0);
		expect(
			buildPrPreviewDedupeIndex(
				[prItem({ prNumber: 7, headSha: '1234567890abcdef' })],
				[driftEntry({ receipts: [receipt({ prNumber: 8, commitSha: 'feedfacefeedface' })] })]
			).size
		).toBe(0);
	});

	it('describes the match for the badge tooltip', () => {
		const index = buildPrPreviewDedupeIndex([prItem()], [driftEntry()]);
		const text = describeDedupeMatch(index.get(101)!);
		expect(text).toContain('agent-alpha');
		expect(text).toContain('PR #101');
	});
});

describe('findPrPreviewForReceipt', () => {
	it('prefers a PR-number match over a SHA match', () => {
		const bySha = prItem({ prNumber: 55, headSha: 'aaaabbbbccccdddd' });
		const byNumber = prItem({ prNumber: 101, headSha: '0000000000000000' });
		const found = findPrPreviewForReceipt(receipt(), [bySha, byNumber]);
		expect(found?.item.prNumber).toBe(101);
		expect(found?.matchedBy).toBe('pr-number');
	});

	it('falls back to a SHA match and null when neither joins', () => {
		const bySha = prItem({ prNumber: 55 });
		expect(findPrPreviewForReceipt(receipt({ prNumber: 999 }), [bySha])?.matchedBy).toBe(
			'head-sha'
		);
		expect(
			findPrPreviewForReceipt(receipt({ prNumber: 999, commitSha: 'feedfacefeedface' }), [bySha])
		).toBeNull();
	});
});

describe('PR previews panel dedupe boundary', () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'pr-previews-panel.svelte'),
		'utf8'
	);

	it('joins client-side and renders the dedupe badge', () => {
		expect(source).toContain('buildPrPreviewDedupeIndex');
		expect(source).toContain('preview exists for this code');
		expect(source).toContain('describeDedupeMatch');
		expect(source).not.toContain('$lib/server');
		expect(source).not.toContain('fetch(');
	});
});

describe('receipt dedupe badge component boundary', () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'preview-receipt-dedupe-badge.svelte'),
		'utf8'
	);

	it('renders only on a join hit and stays server-free', () => {
		expect(source).toContain('findPrPreviewForReceipt');
		expect(source).toContain('preview exists for this code');
		expect(source).toContain('{#if match}');
		expect(source).not.toContain('$lib/server');
		expect(source).not.toContain('fetch(');
	});
});
