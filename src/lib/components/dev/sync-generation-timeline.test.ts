import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	buildSyncCadenceSeries,
	buildSyncGenerationTimeline,
	describeSyncCadence,
	shortGeneration,
	type SyncTimelineVersionInput
} from './sync-generation-timeline';

function version(overrides: Partial<SyncTimelineVersionInput> = {}): SyncTimelineVersionInput {
	return {
		artifactId: overrides.artifactId ?? 'artifact-1',
		createdAt: overrides.createdAt ?? '2026-07-17T10:00:00.000Z',
		payload: {
			tier: 'tar-overlay-set',
			generation: 'gen-abcdef1234567890',
			captureProtocol: 'atomic-generation-v2',
			services: ['workflow-builder'],
			serviceCount: 1,
			iteration: 3,
			...overrides.payload
		},
		promotion: overrides.promotion ?? null,
		acceptance: overrides.acceptance ?? null
	};
}

describe('buildSyncGenerationTimeline', () => {
	it('keeps only generation-bearing captures, newest first', () => {
		const entries = buildSyncGenerationTimeline([
			version({ artifactId: 'old', createdAt: '2026-07-17T09:00:00.000Z' }),
			{ artifactId: 'legacy', createdAt: '2026-07-17T09:30:00.000Z', payload: { tier: 'full' } },
			version({ artifactId: 'new', createdAt: '2026-07-17T11:00:00.000Z' }),
			{ artifactId: 'null-payload', createdAt: '2026-07-17T09:45:00.000Z', payload: null }
		]);
		expect(entries.map((entry) => entry.artifactId)).toEqual(['new', 'old']);
	});

	it('derives services touched, strict flag and short generation', () => {
		const [entry] = buildSyncGenerationTimeline([
			version({
				payload: {
					generation: 'gen-abcdef1234567890',
					captureProtocol: 'atomic-generation-v2',
					services: ['workflow-builder', 'sandbox-execution-api'],
					serviceCount: 2
				}
			})
		]);
		expect(entry.services).toEqual(['workflow-builder', 'sandbox-execution-api']);
		expect(entry.serviceCount).toBe(2);
		expect(entry.strict).toBe(true);
		expect(entry.generation).toBe('gen-abcdef1234567890');
		expect(entry.shortGeneration).toBe(shortGeneration('gen-abcdef1234567890'));
		expect(entry.shortGeneration.length).toBeLessThanOrEqual(10);
	});

	it('marks promote from a stored prUrl or a pull-request receipt', () => {
		const [fromUrl] = buildSyncGenerationTimeline([
			version({ promotion: { prUrl: 'https://github.com/o/r/pull/12' } })
		]);
		expect(fromUrl.promoted).toBe(true);
		expect(fromUrl.prUrl).toBe('https://github.com/o/r/pull/12');

		const [fromReceipt] = buildSyncGenerationTimeline([
			version({ promotion: { pullRequest: { repository: 'o/r', number: 34 } } })
		]);
		expect(fromReceipt.prUrl).toBe('https://github.com/o/r/pull/34');

		const [unpromoted] = buildSyncGenerationTimeline([version()]);
		expect(unpromoted.promoted).toBe(false);
		expect(unpromoted.prUrl).toBeNull();
	});

	it('carries the acceptance tri-state', () => {
		const entries = buildSyncGenerationTimeline([
			version({ artifactId: 'a', acceptance: { ok: true } }),
			version({ artifactId: 'b', createdAt: '2026-07-17T10:01:00.000Z', acceptance: { ok: false } }),
			version({ artifactId: 'c', createdAt: '2026-07-17T10:02:00.000Z' })
		]);
		const byId = new Map(entries.map((entry) => [entry.artifactId, entry.accepted]));
		expect(byId.get('a')).toBe(true);
		expect(byId.get('b')).toBe(false);
		expect(byId.get('c')).toBeNull();
	});

	it('drops records with unparseable timestamps', () => {
		expect(buildSyncGenerationTimeline([version({ createdAt: 'not-a-date' })])).toEqual([]);
	});
});

describe('buildSyncCadenceSeries', () => {
	it('returns [] below three captures or with no span', () => {
		expect(buildSyncCadenceSeries([{ createdAt: '2026-07-17T10:00:00Z' }])).toEqual([]);
		expect(
			buildSyncCadenceSeries([
				{ createdAt: '2026-07-17T10:00:00Z' },
				{ createdAt: '2026-07-17T10:00:00Z' },
				{ createdAt: '2026-07-17T10:00:00Z' }
			])
		).toEqual([]);
	});

	it('buckets every capture exactly once across the span', () => {
		const entries = Array.from({ length: 9 }, (_, i) => ({
			createdAt: new Date(Date.UTC(2026, 6, 17, 10, i * 5)).toISOString()
		}));
		const series = buildSyncCadenceSeries(entries, 8);
		expect(series.length).toBeGreaterThanOrEqual(2);
		expect(series.reduce((sum, point) => sum + point.count, 0)).toBe(9);
		// Monotonic bucket midpoints.
		for (let i = 1; i < series.length; i += 1) {
			expect(series[i].ts.getTime()).toBeGreaterThan(series[i - 1].ts.getTime());
		}
	});

	it('describes the cadence window', () => {
		expect(
			describeSyncCadence([
				{ createdAt: '2026-07-17T10:00:00Z' },
				{ createdAt: '2026-07-17T10:30:00Z' },
				{ createdAt: '2026-07-17T10:34:00Z' }
			])
		).toBe('3 captures over 34m');
		expect(describeSyncCadence([{ createdAt: '2026-07-17T10:00:00Z' }])).toBeNull();
	});
});

describe('SyncGenerationTimeline component boundary', () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), 'sync-generation-timeline.svelte'),
		'utf8'
	);

	it('renders the sparkline with layerchart and stays server-free', () => {
		expect(source).toContain("from 'layerchart'");
		expect(source).toContain('axis={false}');
		expect(source).toContain('buildSyncCadenceSeries');
		expect(source).toContain('buildSyncGenerationTimeline');
		expect(source).not.toContain('$lib/server');
		expect(source).not.toContain('fetch(');
	});

	it('shows capture, promote and acceptance markers plus loading/empty states', () => {
		expect(source).toContain('captured');
		expect(source).toContain('promoted');
		expect(source).toContain('accepted');
		expect(source).toContain('acceptance failed');
		expect(source).toContain('No sync generations yet.');
		expect(source).toContain('motion-safe:animate-pulse');
	});
});
