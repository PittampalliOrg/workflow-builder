import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: {
		CLICKHOUSE_URL: 'http://clickhouse.test:8123',
		CLICKHOUSE_USER: 'test-user',
		CLICKHOUSE_PASSWORD: 'test-password',
		CLICKHOUSE_DB: 'otel',
		CLICKHOUSE_OBS_DB: 'obs'
	}
}));

import {
	getMultiTraceDigestLlmSpans,
	getMultiTraceGraphLlmSpans,
	getMultiTraceSpanSummaries,
	getTraceSpanDetail,
	getTraceSpanDetailForTraces,
	searchTraceLlmSpans,
	searchTraceLogs,
	searchTraceSpanSummaries,
	searchTraceSpans,
	searchTraceToolSpans
} from './clickhouse';

const TRACE_ID = 'c4235a0ea97132eba9adfa3bfbc3ff23';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		TraceId: TRACE_ID,
		SpanId: '0000000000000001',
		ParentSpanId: '',
		SpanName: 'agent.run',
		SpanKind: 'Internal',
		ServiceName: 'agent-runtime',
		DurationMs: 125.4,
		StatusCode: 'Ok',
		StatusMessage: '',
		Timestamp: '2026-07-09 15:27:14.250000000',
		SpanAttr0: 'session-1',
		SpanAttr18: 'postgresql',
		ResourceAttr1: 'exec-1',
		HasInput: 1,
		HasOutput: 0,
		InputSize: 2048,
		OutputSize: 0,
		...overrides
	};
}

function jsonEachRow(rows: Record<string, unknown>[]): Response {
	return new Response(rows.map((value) => JSON.stringify(value)).join('\n'), {
		status: 200
	});
}

describe('compact ClickHouse trace span loading', () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('bounds and truncates summary queries without selecting complete attribute maps', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonEachRow([
				row({ StatusCode: 'Error', StatusMessage: 'model failed' }),
				row({
					SpanId: '0000000000000002',
					HasInput: 0,
					HasOutput: 1,
					OutputSize: 4096
				}),
				row({ SpanId: '0000000000000003' })
			])
		);

		const result = await getMultiTraceSpanSummaries([TRACE_ID], {
			startedAt: '2026-07-09T15:27:14.000Z',
			completedAt: '2026-07-09T15:27:15.000Z',
			limit: 2
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const sql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		expect(sql).not.toMatch(/^\s*SpanAttributes,?\s*$/m);
		expect(sql).not.toMatch(/^\s*ResourceAttributes,?\s*$/m);
		expect(sql).toContain("Timestamp >= '2026-07-09 15:27:09.000'");
		expect(sql).toContain("Timestamp <= '2026-07-09 15:27:25.000'");
		expect(sql).toContain('ORDER BY Timestamp ASC, TraceId ASC, SpanId ASC');
		expect(sql).toContain('LIMIT 3');

		expect(result).toMatchObject({ truncated: true, limit: 2 });
		expect(result.spans).toHaveLength(2);
		expect(result.spans[0]).toMatchObject({
			status: 'error',
			statusCode: 'Error',
			attributesTruncated: true,
			hasInput: true,
			hasOutput: false,
			inputSize: 2048,
			outputSize: 0,
			attributes: {
				'session.id': 'session-1',
				'db.system.name': 'postgresql'
			},
			resourceAttributes: {
				'workflow.execution.id': 'exec-1'
			}
		});
		expect(result.spans[1]).toMatchObject({
			hasInput: false,
			hasOutput: true,
			outputSize: 4096
		});
	});

	it('scopes full span detail by both trace and span identifiers', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonEachRow([
				row({
					SpanAttributes: { 'input.value': 'full input' },
					ResourceAttributes: { 'service.version': 'test' }
				})
			])
		);

		const detail = await getTraceSpanDetail(TRACE_ID, '0000000000000001');

		const sql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		expect(sql).toContain(`WHERE TraceId = '${TRACE_ID}'`);
		expect(sql).toContain("AND SpanId = '0000000000000001'");
		expect(sql).toContain('LIMIT 1');
		expect(detail?.attributes).toEqual({ 'input.value': 'full input' });
		expect(detail?.resourceAttributes).toEqual({ 'service.version': 'test' });
	});

	it('loads graph LLM token counters without message or invocation payloads', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonEachRow([
				{
					TraceId: TRACE_ID,
					SpanId: '0000000000000001',
					ServiceName: 'agent-runtime',
					SessionId: 'session-1',
					ModelName: 'anthropic/claude-opus-4-8',
					PromptTokens: 1200,
					CompletionTokens: 300,
					TotalTokens: 1500,
					CacheReadInputTokens: 800,
					CacheCreationInputTokens: 50
				}
			])
		);

		const spans = await getMultiTraceGraphLlmSpans([TRACE_ID, TRACE_ID], {
			startedAt: '2026-07-09T15:27:14.000Z',
			completedAt: '2026-07-09T15:27:15.000Z'
		});

		const sql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		expect(sql.match(new RegExp(TRACE_ID, 'g'))).toHaveLength(1);
		expect(sql).toContain('CacheReadInputTokens');
		expect(sql).toContain('CacheCreationInputTokens');
		expect(sql).not.toContain('InputMessages');
		expect(sql).not.toContain('OutputMessages');
		expect(sql).not.toContain('InvocationParameters');
		expect(spans).toEqual([
			{
				traceId: TRACE_ID,
				spanId: '0000000000000001',
				serviceName: 'agent-runtime',
				sessionId: 'session-1',
				modelName: 'anthropic/claude-opus-4-8',
				promptTokens: 1200,
				completionTokens: 300,
				totalTokens: 1500,
				cacheReadInputTokens: 800,
				cacheCreationInputTokens: 50
			}
		]);
	});

	it('bounds targeted LLM evidence in SQL and maps all token counters', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonEachRow([
				{
					Timestamp: '2026-07-09 15:27:14.250000000',
					TraceId: TRACE_ID,
					SpanId: '0000000000000001',
					ParentSpanId: '',
					ServiceName: 'agent-runtime',
					SessionId: 'session-1',
					WorkflowExecutionId: 'exec-1',
					AgentRunId: 'run-1',
					ModelName: 'kimi/kimi-k3',
					Provider: 'kimi',
					InputMessages: '[]',
					OutputMessages: '[]',
					InvocationParameters: '{}',
					FinishReason: 'stop',
					PromptTokens: 100,
					CompletionTokens: 20,
					TotalTokens: 120,
					CacheReadInputTokens: 60,
					CacheCreationInputTokens: 15,
					ReasoningTokens: 10,
					StatusCode: 'Ok',
					InputMessagesTruncated: '0',
					OutputMessagesTruncated: '1',
					InvocationParametersTruncated: '0'
				}
			])
		);

		const turns = await searchTraceLlmSpans([TRACE_ID], {
			workflowExecutionId: 'exec-1',
			sessionId: 'session-1',
			limit: 11,
			offset: 20,
			startedAt: '2026-07-09T15:27:14.000Z',
			completedAt: '2026-07-09T15:27:15.000Z'
		});

		const sql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		expect(sql).toContain("SessionId = 'session-1'");
		expect(sql).toContain("WorkflowExecutionId = 'exec-1'");
		expect(sql).toContain('CacheReadInputTokens');
		expect(sql).toContain('CacheCreationInputTokens');
		expect(sql).toContain('ReasoningTokens');
		expect(sql).toContain('LIMIT 11');
		expect(sql).toContain('OFFSET 20');
			expect(turns[0]).toMatchObject({
			cacheReadInputTokens: 60,
			cacheCreationInputTokens: 15,
			reasoningTokens: 10,
			inputMessagesTruncated: false,
			outputMessagesTruncated: true,
			invocationParametersTruncated: false
		});
	});

	it('time-fences every execution-scoped span, log, LLM, and tool query', async () => {
		fetchMock.mockImplementation(async () => jsonEachRow([]));
		const window = {
			startedAt: '2026-07-09T15:27:14.000Z',
			completedAt: '2026-07-09T15:27:15.000Z'
		};

		await getTraceSpanDetailForTraces([TRACE_ID], '0000000000000001', window);
		await searchTraceSpanSummaries([TRACE_ID], { ...window, limit: 10 });
		await searchTraceLogs([TRACE_ID], { ...window, limit: 10 });
		await searchTraceLlmSpans([TRACE_ID], {
			...window,
			workflowExecutionId: 'execution-1',
			limit: 10
		});
		await searchTraceToolSpans([TRACE_ID], {
			...window,
			workflowExecutionId: 'execution-1',
			limit: 10
		});

		expect(fetchMock).toHaveBeenCalledTimes(5);
		for (const call of fetchMock.mock.calls) {
			const sql = String(call[1]?.body ?? '');
			expect(sql).toContain("Timestamp >= '2026-07-09 15:27:09.000'");
			expect(sql).toContain("Timestamp <= '2026-07-09 15:27:25.000'");
		}
	});

	it('loads run-digest LLM totals without transcript columns and reports truncation', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonEachRow([
				{ TraceId: TRACE_ID, SpanId: '1', SessionId: 'session-1' },
				{ TraceId: TRACE_ID, SpanId: '2', SessionId: 'session-1' }
			])
		);

		const batch = await getMultiTraceDigestLlmSpans([TRACE_ID], {}, 1);
		const sql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		expect(sql).not.toContain('InputMessages');
		expect(sql).not.toContain('OutputMessages');
		expect(sql).not.toContain('InvocationParameters');
		expect(sql).toContain('LIMIT 2');
		expect(batch).toMatchObject({ truncated: true, limit: 1 });
		expect(batch.spans).toHaveLength(1);
	});

	it('pushes span and log filters plus page offsets into ClickHouse', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonEachRow([]))
			.mockResolvedValueOnce(jsonEachRow([]));

		await searchTraceSpans([TRACE_ID], {
			query: 'run_tool',
			errorsOnly: true,
			limit: 21,
			offset: 40
		});
		await searchTraceLogs([TRACE_ID], {
			query: 'timeout',
			errorsOnly: true,
			limit: 41,
			offset: 80
		});

		const spanSql = String(fetchMock.mock.calls[0]?.[1]?.body ?? '');
		const logSql = String(fetchMock.mock.calls[1]?.[1]?.body ?? '');
		expect(spanSql).toContain("StatusCode = 'Error'");
		expect(spanSql).toContain('LIMIT 21');
		expect(spanSql).toContain('OFFSET 40');
		expect(logSql).toContain("positionCaseInsensitive(Body, 'timeout')");
		expect(logSql).toContain('LIMIT 41');
		expect(logSql).toContain('OFFSET 80');
	});

	it('applies every immutable preview tuple field to span, log, and LLM reads', async () => {
		const resourceScope = {
			'deployment.environment': 'dev-preview',
			'preview.name': 'feature-one',
			'preview.request_id': 'request-1',
			'preview.platform_revision': 'a'.repeat(40),
			'preview.source_revision': 'b'.repeat(40),
			'preview.catalog_digest': `sha256:${'c'.repeat(64)}`
		};
		fetchMock.mockImplementation(async () => jsonEachRow([]));

		await getMultiTraceSpanSummaries([TRACE_ID], { resourceScope, limit: 10 });
		await getTraceSpanDetailForTraces([TRACE_ID], '0000000000000001', { resourceScope });
		await searchTraceSpans([TRACE_ID], { resourceScope, limit: 10 });
		await searchTraceLogs([TRACE_ID], { resourceScope, limit: 10 });
		await searchTraceLlmSpans([TRACE_ID], {
			workflowExecutionId: 'execution-1',
			spanId: '0000000000000001',
			limit: 1,
			traceResourceScope: resourceScope
		});
		await searchTraceToolSpans([TRACE_ID], {
			workflowExecutionId: 'execution-1',
			limit: 10,
			traceResourceScope: resourceScope
		});
		await getMultiTraceDigestLlmSpans([TRACE_ID], {}, 10, resourceScope);

		expect(fetchMock).toHaveBeenCalledTimes(7);
		for (const call of fetchMock.mock.calls) {
			const sql = String(call[1]?.body ?? '');
			for (const [key, value] of Object.entries(resourceScope)) {
				expect(sql).toContain(
					`ResourceAttributes['${key}'] = '${value}'`
				);
			}
		}
		for (const index of [4, 5, 6]) {
			const sql = String(fetchMock.mock.calls[index]?.[1]?.body ?? '');
			expect(sql).toContain('(TraceId, SpanId) IN');
			expect(sql).toContain('FROM otel.otel_traces');
		}
	});
});
