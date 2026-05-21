import { describe, expect, it } from 'vitest';
import { __capacityBusinessWorkForTest } from './business-work';
import type { CapacityObserverSnapshot } from '$lib/types/capacity';

function snapshot(overrides: Partial<CapacityObserverSnapshot> = {}): CapacityObserverSnapshot {
	return {
		sampledAt: '2026-05-21T00:00:00Z',
		cluster: 'ryzen',
		flavor: 'dev-benchmark',
		resources: [
			{ flavor: 'dev-benchmark', resource: 'cpu', allocatable: 8, requested: 0, criticalRequested: 0, criticalReserve: 1, renderedBudget: 6, headroom: 5 },
			{ flavor: 'dev-benchmark', resource: 'memory', allocatable: 16 * 1024 ** 3, requested: 0, criticalRequested: 0, criticalReserve: 0, renderedBudget: 12 * 1024 ** 3, headroom: 12 * 1024 ** 3 },
			{ flavor: 'dev-benchmark', resource: 'pods', allocatable: 32, requested: 0, criticalRequested: 0, criticalReserve: 4, renderedBudget: 24, headroom: 20 },
			{ flavor: 'dev-benchmark', resource: 'ephemeral-storage', allocatable: 100 * 1024 ** 3, requested: 0, criticalRequested: 0, criticalReserve: 0, renderedBudget: 80 * 1024 ** 3, headroom: 80 * 1024 ** 3 }
		],
		queues: [],
		localQueues: 0,
		sessionCapacity: [],
		blockedWorkloads: [],
		contributors: [],
		nodePressure: {},
		criticalHealth: [],
		recentPreemptions: 0,
		warnings: [],
		...overrides
	};
}

describe('capacity business work aggregation', () => {
	it('groups multiple pods into one active session item', () => {
		const items = __capacityBusinessWorkForTest.aggregateActiveWork(
			snapshot({
				contributors: [
					{
						key: 'pod-a',
						namespace: 'workflow-builder',
						name: 'agent-host',
						kind: 'kueue',
						queue: 'interactive-agent',
						podCount: 1,
						resources: { cpu: 0.5, memory: 1024, pods: 1, 'ephemeral-storage': 0 },
						observedResources: { cpu: 0.2, memory: 512, pods: 0, 'ephemeral-storage': 0 },
						owners: [{ kind: 'session', id: 'session-1', label: 'Session 1', href: '/s/1' }]
					},
					{
						key: 'pod-b',
						namespace: 'workflow-builder',
						name: 'sandbox',
						kind: 'kueue',
						queue: 'interactive-agent',
						podCount: 1,
						resources: { cpu: 1, memory: 2048, pods: 1, 'ephemeral-storage': 10 },
						observedResources: { cpu: 0.4, memory: 1024, pods: 0, 'ephemeral-storage': 0 },
						owners: [{ kind: 'session', id: 'session-1', label: 'Session 1', href: '/s/1' }]
					}
				]
			})
		);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: 'session',
			id: 'session-1',
			podCount: 2,
			contributorCount: 2,
			queues: ['interactive-agent']
		});
		expect(items[0].requestedResources.cpu).toBe(1.5);
		expect(items[0].observedResources.cpu).toBeCloseTo(0.6);
	});

	it('prefers benchmark instance ownership while preserving run/session/agent links', () => {
		const owners = [
			{ kind: 'benchmarkRun' as const, id: 'run-1', label: 'Bench', href: '/bench' },
			{ kind: 'benchmarkInstance' as const, id: 'case-1', label: 'Case', href: '/case' },
			{ kind: 'session' as const, id: 'session-1', label: 'Session', href: '/session' },
			{ kind: 'agent' as const, id: 'agent-1', label: 'Agent', href: '/agent' }
		];
		const [item] = __capacityBusinessWorkForTest.aggregateActiveWork(
			snapshot({
				contributors: [
					{
						key: 'case-pod',
						namespace: 'workflow-builder',
						name: 'agent-host',
						kind: 'kueue',
						queue: 'benchmark-fast',
						podCount: 1,
						resources: { cpu: 1, memory: 1024, pods: 1, 'ephemeral-storage': 0 },
						owners
					}
				]
			})
		);

		expect(item.kind).toBe('benchmarkInstance');
		expect(item.id).toBe('case-1');
		expect(item.owners.map((owner) => owner.kind)).toEqual([
			'benchmarkInstance',
			'benchmarkRun',
			'session',
			'agent'
		]);
	});

	it('falls back to unattributed infrastructure for unlabeled system pods', () => {
		const [item] = __capacityBusinessWorkForTest.aggregateActiveWork(
			snapshot({
				contributors: [
					{
						key: 'critical',
						namespace: 'workflow-builder',
						name: 'postgresql',
						kind: 'critical',
						queue: null,
						podCount: 1,
						resources: { cpu: 0.25, memory: 1024, pods: 1, 'ephemeral-storage': 0 }
					}
				]
			})
		);

		expect(item.kind).toBe('infrastructure');
		expect(item.key).toBe('infrastructure:critical:postgresql');
		expect(item.owners).toEqual([]);
	});

	it('adds blocked workloads to the matching business item', () => {
		const [item] = __capacityBusinessWorkForTest.aggregateActiveWork(
			snapshot({
				blockedWorkloads: [
					{
						namespace: 'workflow-builder',
						name: 'wl-1',
						queue: 'benchmark-fast',
						status: 'pending',
						reason: 'QuotaExceeded',
						message: '',
						pendingSeconds: 45,
						owners: [{ kind: 'session', id: 'session-1', label: 'Session', href: '/session' }]
					}
				]
			})
		);

		expect(item.kind).toBe('session');
		expect(item.blockedWorkloadCount).toBe(1);
		expect(item.queues).toEqual(['benchmark-fast']);
	});
});
