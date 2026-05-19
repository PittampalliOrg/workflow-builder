import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fetchCapacityObserverSnapshot,
	summarizeCapacityObserverForQueue,
} from './observer';
import type { CapacityObserverSnapshot } from '$lib/types/capacity';

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.CAPACITY_OBSERVER_URL;
});

describe('capacity observer client', () => {
	it('returns an unavailable result when the observer cannot be reached', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => {
			throw new Error('ECONNREFUSED');
		}));

		const result = await fetchCapacityObserverSnapshot();

		expect(result).toMatchObject({
			available: false,
			snapshot: null,
			error: 'ECONNREFUSED',
		});
	});

	it('accepts valid snapshots and summarizes queue headroom', async () => {
		const snapshot = sampleSnapshot();
		vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot)));

		const result = await fetchCapacityObserverSnapshot();
		const summary = summarizeCapacityObserverForQueue({
			result,
			queueName: 'benchmark-fast',
			executionClass: 'benchmark-fast',
		});

		expect(result.available).toBe(true);
		expect(summary).toMatchObject({
			available: true,
			cluster: 'dev',
			queue: 'benchmark-fast',
			pendingWorkloads: 2,
			admittedWorkloads: 8,
			fitsAdditionalSessions: 17,
		});
	});
});

function sampleSnapshot(): CapacityObserverSnapshot {
	return {
		sampledAt: '2026-05-19T12:00:00Z',
		cluster: 'dev',
		flavor: 'dev-benchmark',
		resources: [],
		queues: [
			{
				name: 'benchmark-fast',
				cohort: 'agent-platform',
				flavor: 'dev-benchmark',
				admittedWorkloads: 8,
				pendingWorkloads: 2,
				reservingWorkloads: 1,
				admissionWaitP50Seconds: 4,
				admissionWaitP95Seconds: 12,
				resources: [],
			},
		],
		localQueues: 4,
		sessionCapacity: [
			{
				executionClass: 'benchmark-fast',
				queue: 'benchmark-fast',
				request: {},
				limits: {},
				fits: 17,
			},
		],
		blockedWorkloads: [],
		nodePressure: {},
		criticalHealth: [],
		recentPreemptions: 0,
		warnings: [],
	};
}
