import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clickhouseMocks = vi.hoisted(() => ({
	queryClickHouse: vi.fn(),
	getMultiTraceSpanSummaries: vi.fn(),
	getMultiTraceGraphLlmSpans: vi.fn()
}));

vi.mock('$lib/server/otel/clickhouse', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./clickhouse')>();
	return { ...actual, ...clickhouseMocks };
});

import {
	buildServiceGraph,
	resolveExecutionTraceIds,
	type ServiceGraphExecutionContext,
	type ServiceGraphScriptCallRow
} from './service-graph';

const TRACE_ID = 'c4235a0ea97132eba9adfa3bfbc3ff23';

function execution(
	overrides: Partial<ServiceGraphExecutionContext> = {}
): ServiceGraphExecutionContext {
	return {
		id: 'exec-1',
		output: null,
		primaryTraceId: TRACE_ID,
		workflowSessionId: 'exec-1',
		startedAt: new Date('2026-07-16T07:55:36.083Z'),
		completedAt: new Date('2026-07-16T08:23:56.382Z'),
		...overrides
	};
}

const scriptCalls: ServiceGraphScriptCallRow[] = [
	{
		callId: 'plan',
		seq: 0,
		kind: 'agent',
		label: 'Plan',
		phase: 'Plan',
		status: 'done',
		sessionId: 'session-plan',
		retries: 0,
		errorCode: null
	},
	{
		callId: 'build',
		seq: 1,
		kind: 'agent',
		label: 'Build',
		phase: 'Build',
		status: 'done',
		sessionId: 'session-build',
		retries: 0,
		errorCode: null
	}
];

function buildDynamicScriptGraph(row: ServiceGraphExecutionContext) {
	return buildServiceGraph({
		query: {
			mode: 'step',
			scope: 'execution',
			executionId: row.id,
			windowSeconds: 3600
		},
		execution: row,
		scriptCalls
	});
}

describe('service graph runtime loading', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		clickhouseMocks.queryClickHouse.mockResolvedValue([]);
		clickhouseMocks.getMultiTraceSpanSummaries.mockResolvedValue({
			spans: [],
			truncated: false,
			limit: 20_000
		});
		clickhouseMocks.getMultiTraceGraphLlmSpans.mockResolvedValue([]);
	});

	afterEach(() => vi.restoreAllMocks());

	it('queries an execution/session correlation id only once when they are equal', async () => {
		await expect(resolveExecutionTraceIds(execution())).resolves.toEqual([TRACE_ID]);

		expect(clickhouseMocks.queryClickHouse).toHaveBeenCalledOnce();
		expect(String(clickhouseMocks.queryClickHouse.mock.calls[0]?.[0])).toContain("'exec-1'");
	});

	it('keeps the journal graph when trace discovery throws', async () => {
		const brokenOutput = new Proxy<Record<string, unknown>>(
			{},
			{
				get() {
					throw new Error('trace output unreadable');
				}
			}
		);

		const graph = await buildDynamicScriptGraph(
			execution({
				output: brokenOutput,
				primaryTraceId: null,
				workflowSessionId: null
			})
		);

		expect(graph.nodes.map((node) => node.id)).toEqual(['plan', 'build']);
		expect(graph.edges.map((edge) => edge.id)).toEqual(['plan__build']);
		expect(graph.meta).toMatchObject({
			degraded: true,
			spanCount: 0,
			traceCount: 0,
			warnings: ['Trace discovery unavailable; showing journal topology only']
		});
	});

	it('keeps the journal graph when span and LLM enrichment both fail', async () => {
		clickhouseMocks.getMultiTraceSpanSummaries.mockRejectedValueOnce(new Error('span timeout'));
		clickhouseMocks.getMultiTraceGraphLlmSpans.mockRejectedValueOnce(new Error('LLM timeout'));

		const graph = await buildDynamicScriptGraph(execution());

		expect(graph.nodes.map((node) => node.id)).toEqual(['plan', 'build']);
		expect(graph.edges.map((edge) => edge.id)).toEqual(['plan__build']);
		expect(graph.insights?.criticalPath?.[0]).toBe('plan');
		expect(graph.meta).toMatchObject({
			degraded: true,
			spanCount: 0,
			traceCount: 1,
			warnings: [
				'Span timing unavailable; showing journal topology without span metrics',
				'LLM usage unavailable; token and cost metrics omitted'
			]
		});
	});
});
