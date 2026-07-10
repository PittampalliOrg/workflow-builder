import { describe, expect, it, vi } from 'vitest';
import { ApplicationPreviewLifecycleReaperService } from '$lib/server/application/preview-lifecycle-reaper';
import type { VclusterPreviewRecord } from '$lib/types/dev-previews';

function record(overrides: Partial<VclusterPreviewRecord> = {}): VclusterPreviewRecord {
	return {
		name: 'expired-one',
		phase: 'ready',
		ready: true,
		url: 'https://expired-one.example.test',
		targetCluster: 'dev',
		pool: null,
		state: 'hot',
		lifecycle: 'ephemeral',
		origin: { kind: 'user' },
		legacyOrigin: 'user',
		prNumber: null,
		expiresAt: '2026-07-09T20:00:00.000Z',
		lastActive: null,
		protected: false,
		bootSeconds: null,
		platformRevision: 'a'.repeat(40),
		sourceRevision: 'b'.repeat(40),
		profile: 'app-live',
		lane: 'application',
		mode: 'live',
		owner: { kind: 'user', id: 'admin-1' },
		services: ['workflow-builder'],
		provenance: { requestId: 'request-1' },
		trustedCode: true,
		allocation: { kind: 'cold' },
		images: {},
		catalogDigest: `sha256:${'c'.repeat(64)}`,
		...overrides
	};
}

function harness(records: VclusterPreviewRecord[] = [record()]) {
	const previews = {
		listWithCounts: vi.fn(async () => ({ previews: records, counts: null })),
		get: vi.fn(async (name: string) => records.find((row) => row.name === name) ?? record()),
		touch: vi.fn(async (name: string) => ({
			name,
			state: 'hot',
			resuming: true,
			lastActive: null
		})),
		teardown: vi.fn(async (name: string) => record({ name, phase: 'terminating' }))
	};
	const archive = {
		archivePreview: vi.fn(async () => ({
			archived: true as const,
			preview: 'expired-one',
			reason: 'empty',
			executionCount: 0,
			bundleCount: 0,
			bundleErrors: 0
		}))
	};
	return {
		previews,
		archive,
		service: new ApplicationPreviewLifecycleReaperService({
			previews: previews as never,
			archive,
			now: () => new Date('2026-07-09T21:00:00.000Z'),
			batchSize: 3
		})
	};
}

describe('preview lifecycle archive reaper', () => {
	it('archives under the authoritative owner before guarded teardown', async () => {
		const h = harness();
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			expired: 1,
			teardownStarted: 1,
			archiveRefused: 0
		});
		expect(h.archive.archivePreview).toHaveBeenCalledWith({
			name: 'expired-one',
			userId: 'admin-1',
			projectId: null
		});
		expect(h.previews.teardown).toHaveBeenCalledWith('expired-one', {
			mode: 'owned',
			requestId: 'request-1',
			sourceRevision: 'b'.repeat(40),
			archiveConfirmed: true
		});
	});

	it('refuses teardown when archival is not durable', async () => {
		const h = harness();
		h.archive.archivePreview.mockResolvedValueOnce({
			archived: false,
			preview: 'expired-one',
			reason: 'executions-unreachable'
		} as never);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			archiveRefused: 1,
			teardownStarted: 0
		});
		expect(h.previews.teardown).not.toHaveBeenCalled();
	});

	it('directly tears down expired immutable and manifest candidates', async () => {
		const h = harness([
			record({ name: 'reconciled', mode: 'reconciled' }),
			record({
				name: 'manifest',
				profile: 'manifest-candidate',
				mode: 'reconciled',
				services: []
			})
		]);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			expired: 2,
			teardownStarted: 2
		});
		expect(h.archive.archivePreview).not.toHaveBeenCalled();
		expect(h.previews.touch).not.toHaveBeenCalled();
		expect(h.previews.teardown).toHaveBeenCalledTimes(2);
		expect(h.previews.teardown).toHaveBeenCalledWith('reconciled', {
			mode: 'owned',
			requestId: 'request-1',
			sourceRevision: 'b'.repeat(40)
		});
	});

	it('keeps retained previews until expiry, then archives and reaps them', async () => {
		const h = harness([record({ name: 'retained', lifecycle: 'retained' })]);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			expired: 1,
			teardownStarted: 1
		});
		expect(h.archive.archivePreview).toHaveBeenCalledWith({
			name: 'retained',
			userId: 'admin-1',
			projectId: null
		});
	});

	it('does not reap protected, pooled, unprofiled, or unexpired previews', async () => {
		const h = harness([
			record({ name: 'protected', protected: true }),
			record({ name: 'pooled', pool: 'pool-1' }),
			record({ name: 'unprofiled', lifecycle: null }),
			record({ name: 'future', expiresAt: '2026-07-10T20:00:00.000Z' })
		]);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			expired: 0,
			processed: 0
		});
		expect(h.archive.archivePreview).not.toHaveBeenCalled();
		expect(h.previews.teardown).not.toHaveBeenCalled();
	});

	it('wakes a slept preview before attempting its archive', async () => {
		const slept = record({ ready: false, phase: 'slept', state: 'slept' });
		const h = harness([slept]);
		h.previews.get.mockResolvedValueOnce(record());
		await h.service.reapExpired();
		expect(h.previews.touch).toHaveBeenCalledWith('expired-one');
		expect(h.archive.archivePreview).toHaveBeenCalledOnce();
	});

	it('continues immutable cleanup after one teardown fails', async () => {
		const h = harness([
			record({ name: 'immutable-fails', mode: 'reconciled' }),
			record({ name: 'immutable-next', mode: 'reconciled' })
		]);
		h.previews.teardown.mockImplementation(async (name: string) => {
			if (name === 'immutable-fails') throw new Error('broker unavailable');
			return record({ name, phase: 'terminating' });
		});

		await expect(h.service.reapExpired()).resolves.toMatchObject({
			processed: 2,
			teardownStarted: 1,
			teardownFailed: 1,
			items: [
				{ name: 'immutable-fails', status: 'teardown-failed', detail: 'broker unavailable' },
				{ name: 'immutable-next', status: 'teardown-started' }
			]
		});
	});

	it('continues archived mutable cleanup after one teardown fails', async () => {
		const h = harness([record({ name: 'mutable-fails' }), record({ name: 'mutable-next' })]);
		h.previews.teardown.mockImplementation(async (name: string) => {
			if (name === 'mutable-fails') throw new Error('finalizer timeout');
			return record({ name, phase: 'terminating' });
		});

		await expect(h.service.reapExpired()).resolves.toMatchObject({
			processed: 2,
			teardownStarted: 1,
			teardownFailed: 1
		});
		expect(h.archive.archivePreview).toHaveBeenCalledTimes(2);
	});
});
