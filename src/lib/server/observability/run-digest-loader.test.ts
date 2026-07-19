import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ObservabilityLlmSpan,
	ObservabilityTraceSpan
} from '$lib/types/observability';

const mocks = vi.hoisted(() => ({
	getApplicationAdapters: vi.fn(),
	getMultiTraceSpanSummaries: vi.fn(),
	getMultiTraceDigestLlmSpans: vi.fn(),
	isClickHouseConfigured: vi.fn(),
	resolveExecutionTraceIds: vi.fn(),
	buildStepGraphDynamicScript: vi.fn()
}));

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: mocks.getApplicationAdapters
}));

vi.mock('$lib/server/otel/clickhouse', () => ({
	getMultiTraceSpanSummaries: mocks.getMultiTraceSpanSummaries,
	getMultiTraceDigestLlmSpans: mocks.getMultiTraceDigestLlmSpans,
	isClickHouseConfigured: mocks.isClickHouseConfigured
}));

vi.mock('$lib/server/otel/service-graph', () => ({
	resolveExecutionTraceIds: mocks.resolveExecutionTraceIds,
	buildStepGraphDynamicScript: mocks.buildStepGraphDynamicScript
}));

import {
	buildRunDigestForExecution,
	loadExecutionTraceBundle,
	type DigestExecutionRow
} from './run-digest-loader';

const TRACE_ID = 'c4235a0ea97132eba9adfa3bfbc3ff23';

function execution(id: string): DigestExecutionRow {
	return {
		id,
		status: 'completed',
		startedAt: '2026-07-09T15:27:14.000Z',
		completedAt: '2026-07-09T15:27:15.000Z',
		output: {},
		primaryTraceId: TRACE_ID,
		workflowSessionId: 'session-1'
	};
}

function llmSpan(): ObservabilityLlmSpan {
	return {
		timestamp: '2026-07-09T15:27:14.500Z',
		traceId: TRACE_ID,
		spanId: '0000000000000002',
		parentSpanId: null,
		serviceName: 'agent-runtime',
		sessionId: 'session-1',
		workflowExecutionId: 'exec-summary-fails',
		agentRunId: null,
		statusCode: 'Ok',
		modelName: 'test-model',
		provider: 'test',
		inputMessages: [],
		outputMessages: [],
		invocationParameters: null,
		finishReason: 'stop',
		promptTokens: 21,
		completionTokens: 8,
		totalTokens: 29,
		cacheReadInputTokens: 5,
		cacheCreationInputTokens: 3,
		reasoningTokens: null,
		inputMessagesTruncated: false,
		outputMessagesTruncated: false,
		invocationParametersTruncated: false
	};
}

function spanSummary(): ObservabilityTraceSpan {
	return {
		traceId: TRACE_ID,
		spanId: '0000000000000001',
		parentSpanId: null,
		operationName: 'workflow.activity',
		serviceName: 'workflow-orchestrator',
		startTime: '2026-07-09T15:27:14.250Z',
		duration: 120,
		status: 'ok',
		statusCode: 'Ok',
		attributes: { 'session.id': 'session-1' },
		attributesTruncated: true,
		hasInput: true,
		hasOutput: true,
		inputSize: 10,
		outputSize: 20,
		depth: 0
	};
}

describe('run digest trace bundle degradation', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.getApplicationAdapters.mockReturnValue({
			scriptCalls: { listInternal: vi.fn(async () => []) }
		});
		mocks.isClickHouseConfigured.mockReturnValue(true);
		mocks.resolveExecutionTraceIds.mockResolvedValue([TRACE_ID]);
		mocks.buildStepGraphDynamicScript.mockReturnValue({
			nodes: [],
			insights: { nodes: {}, criticalPath: [] }
		});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	it('preserves successful LLM evidence and token totals when span summaries fail', async () => {
		const llm = llmSpan();
		mocks.getMultiTraceSpanSummaries.mockRejectedValue(
			new Error('summary timeout')
		);
		mocks.getMultiTraceDigestLlmSpans.mockResolvedValue({
			spans: [llm],
			truncated: false,
			limit: 20_000
		});

		const row = execution('exec-summary-fails');
		const bundle = await loadExecutionTraceBundle(row);
		const digest = await buildRunDigestForExecution(row);

		expect(bundle.spans).toEqual([]);
		expect(bundle.llmSpans).toEqual([llm]);
		expect(digest.totals).toMatchObject({
			llmCalls: 1,
			tokensIn: 21,
			tokensOut: 8,
			cacheRead: 5,
			cacheCreation: 3,
			tokens: 37
		});
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('Span summary load degraded'),
			'summary timeout'
		);
	});

	it('preserves successful span summaries when the LLM query fails', async () => {
		const span = spanSummary();
		mocks.getMultiTraceSpanSummaries.mockResolvedValue({
			spans: [span],
			truncated: false,
			limit: 20_000
		});
		mocks.getMultiTraceDigestLlmSpans.mockRejectedValue(
			new Error('LLM view unavailable')
		);

		const bundle = await loadExecutionTraceBundle(execution('exec-llm-fails'));

		expect(bundle.spans).toEqual([span]);
		expect(bundle.llmSpans).toEqual([]);
		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('LLM span load degraded'),
			'LLM view unavailable'
		);
	});
});
