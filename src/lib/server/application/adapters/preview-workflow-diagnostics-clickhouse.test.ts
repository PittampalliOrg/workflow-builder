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
});
