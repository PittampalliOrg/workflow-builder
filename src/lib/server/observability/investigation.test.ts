import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ObservabilityTraceSpan,
	ObservabilityWorkflowStep
} from '$lib/types/observability';

const mocks = vi.hoisted(() => ({
	getSessionTraceSpanSummaries: vi.fn(),
	getSessionLogs: vi.fn(),
	getSessionLlmSpans: vi.fn(),
	getSessionToolSpans: vi.fn(),
	getTraceSpanSummaries: vi.fn(),
	getTraceLogs: vi.fn(),
	getTraceLlmSpans: vi.fn(),
	getTraceToolSpans: vi.fn(),
	getMultiTraceSpanSummaries: vi.fn(),
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
	buildExecutionInvestigationFromEvidence,
	buildSessionInvestigation
} from './investigation';

const workflowReader = {
	resolveExecutionForInvestigation: vi.fn(async () => ({
		executionId: 'exec-1',
		sessionId: 'session-1'
	})),
	getWorkflowSteps: vi.fn(async () => ({
		steps: [] as ObservabilityWorkflowStep[],
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
		mocks.getSessionTraceSpanSummaries.mockResolvedValue({
			spans: [traceSpan()],
			truncated: false,
			limit: 20_000
		});
		mocks.getSessionLogs.mockResolvedValue([]);
		mocks.getSessionLlmSpans.mockResolvedValue([]);
		mocks.getSessionToolSpans.mockResolvedValue([]);
		mocks.getTraceSpanSummaries.mockResolvedValue({
			spans: [traceSpan()],
			truncated: false,
			limit: 20_000
		});
		mocks.getTraceLogs.mockResolvedValue([]);
		mocks.getTraceLlmSpans.mockResolvedValue([]);
		mocks.getTraceToolSpans.mockResolvedValue([]);
		mocks.getMultiTraceSpanSummaries.mockResolvedValue({
			spans: [traceSpan()],
			truncated: false,
			limit: 20_000
		});
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
		expect(mocks.getMultiTraceSpanSummaries).toHaveBeenCalledWith(
			['c4235a0ea97132eba9adfa3bfbc3ff23'],
			{
				serviceNames: undefined,
				startedAt: '2026-07-09T15:27:14.000Z',
				completedAt: '2026-07-09T15:27:15.000Z'
			}
		);
	});

	it('keeps LLM, tool, and log evidence when span summaries time out', async () => {
		mocks.getMultiTraceSpanSummaries.mockRejectedValue(new Error('query timeout'));
		mocks.getMultiTraceLogs.mockResolvedValue([
			{
				timestamp: '2026-07-09T15:27:14.500Z',
				traceId: 'c4235a0ea97132eba9adfa3bfbc3ff23',
				spanId: 'span-log',
				serviceName: 'agent-runtime',
				severityText: 'info',
				body: 'agent progress recorded',
				resourceAttributes: {},
				logAttributes: {}
			}
		]);
		mocks.getMultiTraceLlmSpans.mockResolvedValue([
			{
				timestamp: '2026-07-09T15:27:14.600Z',
				traceId: 'c4235a0ea97132eba9adfa3bfbc3ff23',
				spanId: 'span-llm',
				parentSpanId: null,
				serviceName: 'agent-runtime',
				sessionId: 'session-1',
				workflowExecutionId: 'exec-1',
				agentRunId: null,
				statusCode: 'Ok',
				modelName: 'test-model',
				provider: 'test',
				inputMessages: [],
				outputMessages: [],
				invocationParameters: null,
				finishReason: 'stop',
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				cacheReadInputTokens: null,
				cacheCreationInputTokens: null,
				reasoningTokens: null,
				inputMessagesTruncated: false,
				outputMessagesTruncated: false,
				invocationParametersTruncated: false
			}
		]);
		mocks.getMultiTraceToolSpans.mockResolvedValue([
			{
				timestamp: '2026-07-09T15:27:14.700Z',
				traceId: 'c4235a0ea97132eba9adfa3bfbc3ff23',
				spanId: 'span-tool',
				parentSpanId: null,
				serviceName: 'agent-runtime',
				sessionId: 'session-1',
				workflowExecutionId: 'exec-1',
				agentRunId: null,
				statusCode: 'Ok',
				toolName: 'read_file',
				toolArguments: {},
				toolResult: {},
				toolArgumentsTruncated: false,
				toolResultTruncated: false
			}
		]);

		const payload = await buildExecutionInvestigation(
			'exec-1',
			['c4235a0ea97132eba9adfa3bfbc3ff23'],
			undefined,
			{ workflowReader }
		);

		expect(payload.traceSpans).toEqual([]);
		expect(payload.summary.logCount).toBe(1);
		expect(payload.summary.llmTurnCount).toBe(1);
		expect(payload.summary.toolCallCount).toBe(1);
		expect(payload.summary.totalTokens).toBe(15);
		expect(payload.issues).toContainEqual(
			expect.objectContaining({
				id: 'issue-trace-backend-unavailable-execution-exec-1',
				label: expect.stringContaining('spans: query timeout')
			})
		);
	});

	it('projects only bounded execution evidence and surfaces adapter warnings', async () => {
		const payload = await buildExecutionInvestigationFromEvidence(
			'exec-1',
			{
				traceIds: ['c4235a0ea97132eba9adfa3bfbc3ff23'],
				traceSpans: [traceSpan(), traceSpan({ traceId: 'd'.repeat(32), spanId: 'span-2' })],
				logs: [],
				llmSpans: [],
				toolSpans: [],
				truncated: { spans: true, logs: false, llmSpans: false, toolSpans: false },
				rowTruncated: { spans: true, logs: false, llmSpans: false, toolSpans: false },
				contentTruncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
				limits: { spans: 1, logs: 1, llmSpans: 1, toolSpans: 1 },
				degradedSources: [],
				warnings: ['Trace spans were limited to 1 row']
			},
			{ workflowReader }
		);

		expect(payload.traceSpans).toHaveLength(1);
		expect(payload.traceSpans[0]?.traceId).toBe('c4235a0ea97132eba9adfa3bfbc3ff23');
		expect(payload.issues).toContainEqual(
			expect.objectContaining({
				id: 'issue-trace-backend-unavailable-execution-exec-1',
				label: 'Trace spans were limited to 1 row'
			})
		);
	});

	it('bounds and redacts workflow-step content before building the browser payload', async () => {
		workflowReader.getWorkflowSteps.mockResolvedValueOnce({
			steps: Array.from({ length: 201 }, (_, index) => ({
				id: `step-${index}`,
				stepName: `step-${index}`,
				label: `Step ${index}`,
				actionType: 'script',
				status: 'success' as const,
				input: { api_key: 'step-secret', payload: 'i'.repeat(5_000) },
				output: { access_token: 'output-secret', payload: 'o'.repeat(10_000) },
				error: null,
				durationMs: 1,
				startedAt: '2026-07-09T15:27:14.000Z',
				completedAt: '2026-07-09T15:27:14.001Z'
			})),
			status: 'success',
			startedAt: '2026-07-09T15:27:14.000Z',
			completedAt: '2026-07-09T15:27:15.000Z'
		});

		const payload = await buildExecutionInvestigationFromEvidence(
			'exec-1',
			{
				traceIds: ['c4235a0ea97132eba9adfa3bfbc3ff23'],
				traceSpans: [traceSpan()],
				logs: [],
				llmSpans: [],
				toolSpans: [],
				truncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
				rowTruncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
				contentTruncated: { spans: false, logs: false, llmSpans: false, toolSpans: false },
				limits: { spans: 200, logs: 100, llmSpans: 20, toolSpans: 50 },
				degradedSources: [],
				warnings: []
			},
			{ workflowReader }
		);

		expect(payload.workflowSteps).toHaveLength(200);
		expect(Buffer.byteLength(JSON.stringify(payload.workflowSteps[0]?.input), 'utf8')).toBeLessThanOrEqual(2_000);
		expect(Buffer.byteLength(JSON.stringify(payload.workflowSteps[0]?.output), 'utf8')).toBeLessThanOrEqual(4_000);
		expect(JSON.stringify(payload)).not.toContain('step-secret');
		expect(JSON.stringify(payload)).not.toContain('output-secret');
		expect(payload.issues).toContainEqual(
			expect.objectContaining({
				label: expect.stringContaining('Workflow steps were limited to 200 rows')
			})
		);
	});
});
