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

function harness(
	records: VclusterPreviewRecord[] = [record()],
	options: Readonly<{
		now?: () => Date;
		batchSize?: number;
		wakeTimeoutMs?: number;
		archiveRetryGraceMs?: number;
		fairnessWindowMs?: number;
	}> = {}
) {
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
		archivePreview: vi.fn(async (input: { name: string }) => ({
			archived: true as const,
			preview: input.name,
			reason: 'empty',
			executionCount: 0,
			bundleCount: 0,
			bundleErrors: 0
		})),
		quarantinePreview: vi.fn(
			async ({ preview, reason }: { preview: { name: string }; reason: string }) => ({
				archived: false as const,
				quarantined: true as const,
				preview: preview.name,
				reason: `forced-quarantine:${reason}`,
				summaryFileId: `quarantine-${preview.name}`
			})
		)
	};
	return {
		previews,
		archive,
		service: new ApplicationPreviewLifecycleReaperService({
			previews: previews as never,
			archive,
			now: options.now ?? (() => new Date('2026-07-09T21:00:00.000Z')),
			batchSize: options.batchSize ?? 3,
			wakeTimeoutMs: options.wakeTimeoutMs ?? 1,
			wakePollMs: 1,
			sleep: async () => undefined,
			archiveRetryGraceMs: options.archiveRetryGraceMs ?? 2 * 60 * 60_000,
			fairnessWindowMs: options.fairnessWindowMs ?? 60_000
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

	it('retries an incomplete archive and never forces before the grace boundary', async () => {
		const h = harness();
		h.archive.archivePreview.mockResolvedValueOnce({
			archived: false,
			preview: 'expired-one',
			reason: 'executions-unreachable'
		} as never);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			archiveRefused: 1,
			retryDeferred: 1,
			teardownStarted: 0,
			quarantineTeardownStarted: 0,
			items: [
				{
					name: 'expired-one',
					status: 'archive-retry',
					graceExpiredAt: '2026-07-09T22:00:00.000Z'
				}
			]
		});
		expect(h.previews.teardown).not.toHaveBeenCalled();
		expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
	});

	it('forces a clearly marked quarantine teardown after archive grace expires', async () => {
		const h = harness([record()], {
			now: () => new Date('2026-07-09T22:00:00.001Z'),
			archiveRetryGraceMs: 2 * 60 * 60_000
		});
		h.archive.archivePreview.mockResolvedValueOnce({
			archived: false,
			preview: 'expired-one',
			reason: 'incomplete:active-generation-unverified',
			summaryFileId: 'partial-summary',
			executionCount: 1
		} as never);

		await expect(h.service.reapExpired()).resolves.toMatchObject({
			teardownStarted: 1,
			quarantineTeardownStarted: 1,
			retryDeferred: 0,
			items: [
				{
					name: 'expired-one',
					status: 'quarantine-teardown-started',
					forced: true,
					graceExpiredAt: '2026-07-09T22:00:00.000Z'
				}
			]
		});
		expect(h.archive.quarantinePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'incomplete:active-generation-unverified',
				forcedAt: '2026-07-09T22:00:00.001Z',
				graceExpiredAt: '2026-07-09T22:00:00.000Z'
			})
		);
		expect(h.previews.teardown).toHaveBeenCalledWith('expired-one', {
			mode: 'owned',
			requestId: 'request-1',
			sourceRevision: 'b'.repeat(40),
			archiveConfirmed: true,
			archiveQuarantine: {
				forcedAt: '2026-07-09T22:00:00.001Z',
				graceExpiredAt: '2026-07-09T22:00:00.000Z',
				reason: 'incomplete:active-generation-unverified',
				summaryFileId: 'quarantine-expired-one'
			}
		});
	});

	it('defers an active execution archive until grace instead of forcing early', async () => {
		const h = harness();
		h.archive.archivePreview.mockResolvedValueOnce({
			archived: false,
			preview: 'expired-one',
			reason: 'incomplete:active-generation-unverified',
			summaryFileId: 'active-partial-summary',
			executionCount: 1
		} as never);
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			retryDeferred: 1,
			quarantineTeardownStarted: 0,
			items: [
				{
					status: 'archive-retry',
					detail: 'incomplete:active-generation-unverified',
					graceExpiredAt: '2026-07-09T22:00:00.000Z'
				}
			]
		});
		expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
		expect(h.previews.teardown).not.toHaveBeenCalled();
	});

	it('retries a wake failure during grace and does not archive or force', async () => {
		const h = harness([record({ ready: false, phase: 'slept', state: 'slept' })]);
		h.previews.touch.mockRejectedValueOnce(new Error('wake API unavailable'));
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			retryDeferred: 1,
			teardownStarted: 0,
			items: [
				{
					status: 'wake-retry',
					detail: 'wake request failed: wake API unavailable'
				}
			]
		});
		expect(h.archive.archivePreview).not.toHaveBeenCalled();
		expect(h.archive.quarantinePreview).not.toHaveBeenCalled();
		expect(h.previews.teardown).not.toHaveBeenCalled();
	});

	it('forces teardown after grace even when wake and quarantine marker writes fail', async () => {
		const h = harness([record({ ready: false, phase: 'slept', state: 'slept' })], {
			now: () => new Date('2026-07-09T23:00:00.000Z')
		});
		h.previews.touch.mockRejectedValueOnce(new Error('wake API unavailable'));
		h.archive.quarantinePreview.mockRejectedValueOnce(new Error('host files unavailable'));
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			quarantineTeardownStarted: 1,
			items: [
				{
					status: 'quarantine-teardown-started',
					forced: true,
					detail: 'quarantine marker failed: host files unavailable'
				}
			]
		});
		expect(h.previews.teardown).toHaveBeenCalledWith(
			'expired-one',
			expect.objectContaining({
				mode: 'owned',
				archiveConfirmed: true,
				archiveQuarantine: expect.objectContaining({
					reason: 'wake-unavailable:wake request failed: wake API unavailable'
				})
			})
		);
	});

	it('forces teardown after grace when the archive call throws', async () => {
		const h = harness([record()], {
			now: () => new Date('2026-07-09T23:00:00.000Z')
		});
		h.archive.archivePreview.mockRejectedValueOnce(new Error('read broker unavailable'));
		await expect(h.service.reapExpired()).resolves.toMatchObject({
			quarantineTeardownStarted: 1,
			items: [
				{
					status: 'quarantine-teardown-started',
					forced: true
				}
			]
		});
		expect(h.archive.quarantinePreview).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: 'archive-error:read broker unavailable'
			})
		);
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
				{
					name: 'immutable-fails',
					status: 'teardown-failed',
					detail: 'broker unavailable'
				},
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

	it('rotates a bounded batch fairly so stuck oldest previews cannot starve later expirations', async () => {
		let now = new Date('2026-07-09T20:01:00.000Z');
		const records = ['fair-a', 'fair-b', 'fair-c', 'fair-d'].map((name) =>
			record({ name, expiresAt: '2026-07-09T20:00:00.000Z' })
		);
		const h = harness(records, {
			now: () => now,
			batchSize: 1,
			fairnessWindowMs: 60_000,
			archiveRetryGraceMs: 24 * 60 * 60_000
		});
		h.archive.archivePreview.mockResolvedValue({
			archived: false,
			preview: 'stuck',
			reason: 'incomplete:active-generation-unverified'
		} as never);

		for (let slot = 0; slot < records.length; slot += 1) {
			await h.service.reapExpired();
			now = new Date(now.getTime() + 60_000);
		}

		expect(h.archive.archivePreview.mock.calls.map(([input]) => input.name)).toEqual([
			'fair-b',
			'fair-c',
			'fair-d',
			'fair-a'
		]);
		expect(new Set(h.archive.archivePreview.mock.calls.map(([input]) => input.name))).toEqual(
			new Set(records.map((row) => row.name))
		);
		expect(h.previews.teardown).not.toHaveBeenCalled();
	});
});
