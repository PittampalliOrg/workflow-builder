import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	PreviewControlIdentity,
	WorkflowDiagnosticsExecution
} from '$lib/server/application/ports';
import { ClickHousePreviewWorkflowDiagnosticsQueryAdapter } from './preview-workflow-diagnostics-clickhouse';

vi.mock('$env/dynamic/private', () => ({
	env: {
		CLICKHOUSE_URL: 'http://clickhouse.test:8123',
		CLICKHOUSE_USER: 'test-user',
		CLICKHOUSE_PASSWORD: 'test-password',
		CLICKHOUSE_DB: 'otel',
		CLICKHOUSE_OBS_DB: 'obs'
	}
}));

const identity: PreviewControlIdentity = {
	previewName: 'feature-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}`
};
const execution: WorkflowDiagnosticsExecution = {
	id: 'execution-1',
	userId: 'user-1',
	projectId: 'project-1',
	status: 'error',
	startedAt: new Date('2026-07-19T12:00:00.000Z'),
	completedAt: new Date('2026-07-19T12:01:00.000Z'),
	output: null,
	executionIr: null,
	primaryTraceId: 'a'.repeat(32),
	workflowSessionId: 'session-1'
};

describe('preview workflow diagnostics ClickHouse adapter', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it('resolves execution and session correlation separately inside the exact tuple', async () => {
		const sql: string[] = [];
		const adapter = new ClickHousePreviewWorkflowDiagnosticsQueryAdapter(
			async (statement) => {
				sql.push(statement);
				return [];
			}
		);

		await adapter.resolveTraceIds({ identity, execution });

		expect(sql).toHaveLength(1);
		expect(sql[0]).toContain("SpanAttributes['workflow.execution.id'] = 'execution-1'");
		expect(sql[0]).not.toContain("SpanAttributes['session.id'] = 'execution-1'");
		expect(sql[0]).toContain("SpanAttributes['session.id'] = 'session-1'");
		expect(sql[0]).not.toContain("SpanAttributes['workflow.execution.id'] = 'session-1'");
		for (const [key, value] of Object.entries({
			'deployment.environment': 'dev-preview',
			'preview.name': identity.previewName,
			'preview.request_id': identity.environmentRequestId,
			'preview.platform_revision': identity.environmentPlatformRevision,
			'preview.source_revision': identity.environmentSourceRevision,
			'preview.catalog_digest': identity.catalogDigest
		})) {
			expect(sql[0]).toContain(`ResourceAttributes['${key}'] = '${value}'`);
		}
	});

	it('short-circuits a requested trace set when fresh tuple resolution allows none', async () => {
		const queryImpl = vi.fn(async () => []);
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
		const adapter = new ClickHousePreviewWorkflowDiagnosticsQueryAdapter(queryImpl);

		await expect(
			adapter.searchSpans({
				identity,
				execution,
				traceIds: ['f'.repeat(32)],
				query: { limit: 10, offset: 0 }
			})
		).resolves.toEqual([]);
		expect(queryImpl).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fences every bounded investigation category to the immutable tuple', async () => {
		const queryImpl = vi.fn(async () => [{ TraceId: 'a'.repeat(32) }]);
		const fetchMock = vi.fn<typeof fetch>();
		fetchMock.mockImplementation(async () => new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = new ClickHousePreviewWorkflowDiagnosticsQueryAdapter(queryImpl);

		await adapter.loadInvestigationEvidence({
			identity,
			execution,
			request: {
				categories: ['spans', 'logs', 'llmSpans', 'toolSpans'],
				serviceNames: ['agent-runtime'],
				limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 }
			}
		});

		expect(queryImpl).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const statements = fetchMock.mock.calls.map(([, init]) => String(init?.body));
		for (const statement of statements) {
			for (const [key, value] of Object.entries({
				'deployment.environment': 'dev-preview',
				'preview.name': identity.previewName,
				'preview.request_id': identity.environmentRequestId,
				'preview.platform_revision': identity.environmentPlatformRevision,
				'preview.source_revision': identity.environmentSourceRevision,
				'preview.catalog_digest': identity.catalogDigest
			})) {
				expect(statement).toContain(`ResourceAttributes['${key}'] = '${value}'`);
			}
			expect(statement).toContain("ServiceName IN ('agent-runtime')");
			expect(statement).toContain("Timestamp >= '2026-07-19 11:59:55.000'");
			expect(statement).toContain("Timestamp <= '2026-07-19 12:01:10.000'");
		}
		const spanStatement = statements.find((statement) => statement.includes('AS SpanAttr0'));
		expect(spanStatement).toBeDefined();
		expect(spanStatement).not.toMatch(/\n\s*SpanAttributes,\s*\n/);
		expect(spanStatement).not.toMatch(/\n\s*ResourceAttributes\s*\n/);
		expect(statements.some((statement) => statement.includes('FROM obs.tool_spans'))).toBe(true);
		expect(statements.find((statement) => statement.includes('FROM obs.tool_spans'))).toContain(
			"WorkflowExecutionId = 'execution-1'"
		);
		expect(statements).toEqual(
			expect.arrayContaining([
				expect.stringContaining('LIMIT 11'),
				expect.stringContaining('LIMIT 21'),
				expect.stringContaining('LIMIT 6')
			])
		);
	});

	it('time- and tuple-fences paged search and exact span detail', async () => {
		const queryImpl = vi.fn(async () => [{ TraceId: 'a'.repeat(32) }]);
		const fetchMock = vi.fn<typeof fetch>();
		fetchMock.mockImplementation(async () => new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const adapter = new ClickHousePreviewWorkflowDiagnosticsQueryAdapter(queryImpl);

		await adapter.searchSpans({
			identity,
			execution,
			traceIds: ['a'.repeat(32)],
			query: { limit: 10, offset: 0 }
		});
		await adapter.getSpan({
			identity,
			execution,
			traceIds: ['a'.repeat(32)],
			spanId: '1'.repeat(16)
		});
		await adapter.searchLlmSpans({
			identity,
			execution,
			traceIds: ['a'.repeat(32)],
			query: { workflowExecutionId: execution.id, limit: 10, offset: 0 }
		});
		await adapter.searchLogs({
			identity,
			execution,
			traceIds: ['a'.repeat(32)],
			query: { limit: 10, offset: 0 }
		});

		expect(fetchMock).toHaveBeenCalledTimes(4);
		for (const [, init] of fetchMock.mock.calls) {
			const statement = String(init?.body);
			expect(statement).toContain("Timestamp >= '2026-07-19 11:59:55.000'");
			expect(statement).toContain("Timestamp <= '2026-07-19 12:01:10.000'");
			expect(statement).toContain("ResourceAttributes['preview.name'] = 'feature-one'");
		}
	});
});
