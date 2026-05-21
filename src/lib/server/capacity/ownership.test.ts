import { describe, expect, it } from 'vitest';
import { __capacityOwnershipForTest } from './ownership';

describe('capacity ownership helpers', () => {
	it('matches the per-session agent workflow host app id', () => {
		expect(__capacityOwnershipForTest.sessionHostAppId('session-1')).toMatch(
			/^agent-session-[a-f0-9]{20}$/
		);
		expect(__capacityOwnershipForTest.sessionHostAppId('session-1')).toBe(
			__capacityOwnershipForTest.sessionHostAppId('session-1')
		);
	});

	it('normalizes benchmark labels the same way as host execution labels', () => {
		expect(__capacityOwnershipForTest.normalizeHostExecutionLabelValue('Run_ABC/123')).toBe(
			'run-abc-123'
		);
		expect(
			__capacityOwnershipForTest.normalizeHostExecutionLabelValue('x'.repeat(80)).length
		).toBe(63);
	});

	it('builds run session and agent links from a resolved session row', () => {
		const owners = __capacityOwnershipForTest.sessionOwners(
			{
				sessionId: 'session-1',
				sessionTitle: 'Investigate queue',
				sessionRuntimeAppId: 'agent-session-deadbeef',
				agentId: 'agent-1',
				agentName: 'Capacity Agent',
				agentSlug: 'capacity-agent',
				workflowExecutionId: 'exec-1',
				workflowId: 'workflow-1',
				workflowName: 'Capacity Workflow'
			},
			'dev',
			{ sessionId: 'session-1', source: 'pod' }
		);

		expect(owners.map((owner) => owner.kind)).toEqual(['workflowRun', 'session', 'agent']);
		expect(owners[0].href).toBe('/workspaces/dev/workflows/workflow-1/runs/exec-1');
		expect(owners[1].href).toBe('/workspaces/dev/sessions/session-1');
		expect(owners[2].href).toBe('/workspaces/dev/agents/agent-1');
	});

	it('deduplicates owners while preserving the preferred display order', () => {
		const owners = __capacityOwnershipForTest.dedupeOwners([
			{ kind: 'agent', id: 'agent-1', label: 'Agent', href: '/a' },
			{ kind: 'session', id: 'session-1', label: 'Session', href: '/s' },
			{ kind: 'agent', id: 'agent-1', label: 'Agent', href: '/a' },
			{ kind: 'workflowRun', id: 'exec-1', label: 'Run', href: '/r' }
		]);

		expect(owners.map((owner) => `${owner.kind}:${owner.id}`)).toEqual([
			'workflowRun:exec-1',
			'session:session-1',
			'agent:agent-1'
		]);
	});

	it('expands benchmark ownership into run session agent bench and case links', () => {
		const owners = __capacityOwnershipForTest.benchmarkOwners(
			{
				runId: 'run-1',
				runStatus: 'running',
				runInstanceRowId: 'case-row-1',
				instanceId: 'sympy__sympy-20590',
				agentId: 'agent-1',
				agentName: 'DeepSeek Smoke',
				agentSlug: 'deepseek-smoke',
				workflowExecutionId: 'exec-1',
				workflowId: 'workflow-1',
				workflowName: 'SWE-bench instance runner',
				sessionId: 'session-1',
				sessionTitle: 'SWE-bench solve'
			},
			'dev',
			{ benchmarkInstanceId: 'sympy__sympy-20590', source: 'pod' }
		);

		expect(owners.map((owner) => owner.kind)).toEqual([
			'workflowRun',
			'session',
			'agent',
			'benchmarkRun',
			'benchmarkInstance'
		]);
		expect(owners[0].href).toBe('/workspaces/dev/workflows/workflow-1/runs/exec-1');
		expect(owners[1].href).toBe('/workspaces/dev/sessions/session-1');
		expect(owners[2].href).toBe('/workspaces/dev/agents/agent-1');
		expect(owners[3].href).toBe('/workspaces/dev/benchmarks/runs/run-1');
	});
});
