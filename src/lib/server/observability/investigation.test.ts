import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObservabilityTraceSpan } from '$lib/types/observability';

const mocks = vi.hoisted(() => ({
	getSessionTraceSpans: vi.fn(),
	getSessionLogs: vi.fn(),
	getSessionLlmSpans: vi.fn(),
	getSessionToolSpans: vi.fn(),
	getTraceSpans: vi.fn(),
	getTraceLogs: vi.fn(),
	getTraceLlmSpans: vi.fn(),
	getTraceToolSpans: vi.fn(),
	getMultiTraceSpans: vi.fn(),
	getMultiTraceLogs: vi.fn(),
	getMultiTraceLlmSpans: vi.fn(),
	getMultiTraceToolSpans: vi.fn()
}));

vi.mock('$lib/server/otel/clickhouse', () => ({
	CLICKHOUSE_DB: 'otel',
	escapeClickHouseString: (value: string) => value,
	extractExecutionTraceIds: () => [],
	findCorrelatedTraceIds: vi.fn(async () => []),
	queryClickHouse: vi.fn(async () => []),
	sanitizeTraceIds: (traceIds: string[]) =>
		traceIds
			.filter((id) => typeof id === 'string' && /^[a-f0-9]+$/i.test(id.trim()))
			.map((id) => id.trim()),
	...mocks
}));

vi.mock('$lib/server/observability/goal-flow', () => ({
	buildGoalFlow: vi.fn(async () => null)
}));

import {
	buildExecutionInvestigation,
	buildSessionInvestigation
} from './investigation';

const workflowReader = {
	resolveExecutionForInvestigation: vi.fn(async () => ({
		executionId: 'exec-1',
		sessionId: 'session-1'
	})),
	getWorkflowSteps: vi.fn(async () => ({
		steps: [],
		status: 'success',
		startedAt: '2026-07-09T15:27:14.000Z',
		completedAt: '2026-07-09T15:27:15.000Z'
	}))
};

function traceSpan(overrides: Partial<ObservabilityTraceSpan> = {}): ObservabilityTraceSpan {
	return {
		traceId: 'c4235a0ea97132eba9adfa3bfbc3ff23',
		spanId: 'span-1',
		parentSpanId: null,
		operationName: 'workflow_script_calls.select_by_execution',
		serviceName: 'workflow-builder',
		startTime: '2026-07-09T15:27:14.250Z',
		duration: 12,
		status: 'ok',
		statusCode: 'Ok',
		spanKind: 'Client',
		depth: 0,
		attributes: {
			'db.system.name': 'postgresql',
			'db.query.text': 'select * from workflow_script_calls where execution_id = $1'
		},
		...overrides
	};
}

describe('observability investigation trace backend degradation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.getSessionTraceSpans.mockResolvedValue([traceSpan()]);
		mocks.getSessionLogs.mockResolvedValue([]);
		mocks.getSessionLlmSpans.mockResolvedValue([]);
		mocks.getSessionToolSpans.mockResolvedValue([]);
		mocks.getTraceSpans.mockResolvedValue([traceSpan()]);
		mocks.getTraceLogs.mockResolvedValue([]);
		mocks.getTraceLlmSpans.mockResolvedValue([]);
		mocks.getTraceToolSpans.mockResolvedValue([]);
		mocks.getMultiTraceSpans.mockResolvedValue([traceSpan()]);
		mocks.getMultiTraceLogs.mockResolvedValue([]);
		mocks.getMultiTraceLlmSpans.mockResolvedValue([]);
		mocks.getMultiTraceToolSpans.mockResolvedValue([]);
	});

	it('keeps session trace spans when the logs query fails', async () => {
		mocks.getSessionLogs.mockRejectedValue(new Error('fetch failed'));

		const payload = await buildSessionInvestigation('session-1', { workflowReader });

		expect(payload.summary.spanCount).toBe(1);
		expect(payload.summary.logCount).toBe(0);
		expect(payload.traceSpans[0]?.operationName).toBe('workflow_script_calls.select_by_execution');
		expect(payload.issues.some((issue) => issue.label.includes('partially unavailable'))).toBe(true);
		expect(payload.summary.traceIds).toEqual(['c4235a0ea97132eba9adfa3bfbc3ff23']);
	});

	it('keeps execution trace spans when the multi-trace logs query fails', async () => {
		mocks.getMultiTraceLogs.mockRejectedValue(new Error('fetch failed'));

		const payload = await buildExecutionInvestigation(
			'exec-1',
			['c4235a0ea97132eba9adfa3bfbc3ff23'],
			undefined,
			{ workflowReader }
		);

		expect(payload.summary.spanCount).toBe(1);
		expect(payload.traceSpans[0]?.attributes?.['db.query.text']).toContain(
			'workflow_script_calls'
		);
		expect(payload.issues).toContainEqual(
			expect.objectContaining({
				id: 'issue-trace-backend-unavailable-execution-exec-1',
				severity: 'warning'
			})
		);
	});
});
