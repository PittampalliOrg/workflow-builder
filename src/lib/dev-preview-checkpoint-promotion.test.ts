import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
	promoteStrictCheckpointUntilConfirmed,
	strictCheckpointPromotionReceiptFromVersion,
	type StrictCheckpointPromotionProgress
} from './dev-preview-checkpoint-promotion';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function immediate(artifactId = 'artifact-1') {
	return {
		action: 'promote',
		ok: true,
		artifactId,
		receiptId: 'receipt-1',
		draft: true,
		branch: 'preview-feature-1234',
		prUrl: 'https://github.com/PittampalliOrg/workflow-builder/pull/601',
		pullRequest: {
			repository: 'PittampalliOrg/workflow-builder',
			number: 601
		}
	};
}

function version(artifactId = 'artifact-1') {
	return {
		artifactId,
		payload: {
			tier: 'tar-overlay-set',
			captureProtocol: 'atomic-generation-v2'
		},
		promotion: {
			receiptId: 'receipt-1',
			branch: 'preview-feature-1234',
			prUrl: 'https://github.com/PittampalliOrg/workflow-builder/pull/601',
			repository: 'PittampalliOrg/workflow-builder',
			pullRequestNumber: 601,
			baseSha: BASE_SHA,
			headSha: HEAD_SHA,
			commitSha: HEAD_SHA
		}
	};
}

describe('promoteStrictCheckpointUntilConfirmed', () => {
	it('accepts an exact immediate promotion receipt', async () => {
		const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
			json(immediate())
		);
		const progress: StrictCheckpointPromotionProgress[] = [];

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', 'Checkpoint', {
				fetcher,
				onProgress: (phase) => progress.push(phase)
			})
		).resolves.toMatchObject({
			artifactId: 'artifact-1',
			receiptId: 'receipt-1',
			pullRequestNumber: 601
		});
		expect(progress).toEqual(['submitting', 'complete']);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
	});

	it('observes the exact durable artifact after the POST response is lost', async () => {
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('network changed'))
			.mockResolvedValueOnce(json({ versions: [version()] }));
		const progress: StrictCheckpointPromotionProgress[] = [];

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', null, {
				fetcher,
				onProgress: (phase) => progress.push(phase)
			})
		).resolves.toMatchObject({ receiptId: 'receipt-1', branch: 'preview-feature-1234' });
		expect(progress).toEqual(['submitting', 'confirming', 'complete']);
		expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual(['POST', 'GET']);
	});

	it('replays the exact strict command once when its local projection is missing', async () => {
		let now = 0;
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
			.mockResolvedValueOnce(json({ versions: [] }))
			.mockResolvedValueOnce(json({ versions: [] }))
			.mockResolvedValueOnce(json(immediate()));
		const sleep = vi.fn(async (milliseconds: number) => {
			now += milliseconds;
		});

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', 'Checkpoint', {
				fetcher,
				sleep,
				now: () => now,
				timeoutMs: 5_000,
				pollIntervalMs: 1_000,
				replayAfterMs: 1_000
			})
		).resolves.toMatchObject({ receiptId: 'receipt-1' });
		expect(fetcher.mock.calls.map(([, init]) => init?.method ?? 'GET')).toEqual([
			'POST',
			'GET',
			'GET',
			'POST'
		]);
	});

	it('never accepts another artifact or a receipt-less projection', async () => {
		let now = 0;
		const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === 'POST') throw new TypeError('connection reset');
			const receiptless = version('artifact-1');
			receiptless.promotion.receiptId = '';
			return json({ versions: [version('artifact-2'), receiptless] });
		});
		const sleep = vi.fn(async (milliseconds: number) => {
			now += milliseconds;
		});

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', null, {
				fetcher,
				sleep,
				now: () => now,
				timeoutMs: 2_500,
				pollIntervalMs: 1_000,
				replayAfterMs: 1_000
			})
		).rejects.toThrow('GitHub handoff could not yet be confirmed');
		expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
	});

	it('fails immediately on a semantic authorization response', async () => {
		const fetcher = vi.fn(async () => json({ message: 'Admin access required' }, 403));
		const sleep = vi.fn(async () => undefined);

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', null, {
				fetcher,
				sleep
			})
		).rejects.toThrow('Admin access required');
		expect(fetcher).toHaveBeenCalledOnce();
		expect(sleep).not.toHaveBeenCalled();
	});

	it('does not replay a semantic rate-limit response', async () => {
		const fetcher = vi.fn(async () => json({ message: 'Try again later' }, 429));
		const sleep = vi.fn(async () => undefined);

		await expect(
			promoteStrictCheckpointUntilConfirmed('execution-1', 'artifact-1', null, {
				fetcher,
				sleep
			})
		).rejects.toThrow('Try again later');
		expect(fetcher).toHaveBeenCalledOnce();
		expect(sleep).not.toHaveBeenCalled();
	});

	it('keeps a hung request inside the operation deadline', async () => {
		vi.useFakeTimers();
		try {
			const fetcher = vi.fn(
				async (_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
							once: true
						});
					})
			);
			const pending = promoteStrictCheckpointUntilConfirmed(
				'execution-1',
				'artifact-1',
				null,
				{ fetcher, timeoutMs: 100 }
			);
			const rejected = expect(pending).rejects.toThrow(
				'GitHub handoff could not yet be confirmed'
			);

			await vi.advanceTimersByTimeAsync(100);
			await rejected;
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects a projection whose PR tuple or commit provenance is inconsistent', () => {
		const wrongTuple = version();
		wrongTuple.promotion.pullRequestNumber = 602;
		const wrongCommit = version();
		wrongCommit.promotion.commitSha = '3'.repeat(40);

		expect(strictCheckpointPromotionReceiptFromVersion(wrongTuple, 'artifact-1')).toBeNull();
		expect(strictCheckpointPromotionReceiptFromVersion(wrongCommit, 'artifact-1')).toBeNull();
	});

	it('stays on the client side of the hexagonal boundary', () => {
		const source = readFileSync(new URL('./dev-preview-checkpoint-promotion.ts', import.meta.url), 'utf8');
		expect(source).not.toContain('$lib/server');
		expect(source).not.toContain('/api/internal/');
	});
});
