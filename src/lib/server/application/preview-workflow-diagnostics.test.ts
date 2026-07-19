import { describe, expect, it, vi } from 'vitest';
import type { PreviewWorkflowDiagnosticsOperation } from './ports';
import type { PreviewWorkflowDiagnosticsBrokerCommand } from './preview-workflow-diagnostics';
import {
	ApplicationPreviewWorkflowDiagnosticsBrokerService,
	PreviewWorkflowDiagnosticsError
} from './preview-workflow-diagnostics';

const identity = {
	previewName: 'feature-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}` as const
};

function command(
	operation: PreviewWorkflowDiagnosticsOperation = 'resolve-trace-ids',
	request: unknown = {}
): PreviewWorkflowDiagnosticsBrokerCommand {
	return {
		identity,
		authorization: 'proof',
		operation,
		execution: {
			id: 'execution-1',
			userId: 'user-1',
			projectId: 'project-1',
			status: 'error',
			startedAt: new Date('2026-07-19T12:00:00.000Z'),
			completedAt: new Date('2026-07-19T12:01:00.000Z'),
			output: null,
			executionIr: null,
			primaryTraceId: null,
			workflowSessionId: null
		},
		request
	};
}

function harness() {
	const order: string[] = [];
	const authorization = {
		issue: vi.fn(() => 'proof'),
		verify: vi.fn(() => {
			order.push('proof');
			return true;
		})
	};
	const authority = {
		authorizeTraceTuple: vi.fn(async () => {
			order.push('tuple');
			return { owner: 'user-1' };
		})
	};
	const workspaces = {
		hasMembership: vi.fn(async () => {
			order.push('workspace');
			return true;
		})
	};
	const queries = {
		isConfigured: vi.fn(() => true),
		loadDigestTelemetry: vi.fn(async () => ({
			traceIds: [], spans: [], llmSpans: [], llmSpansTruncated: false,
			llmSpanLimit: 2_000, degradedSources: [], warnings: []
		})),
		resolveTraceIds: vi.fn(async () => {
			order.push('query');
			return { traceIds: [], warnings: [] };
		}),
		searchSpans: vi.fn(async () => []),
		getSpan: vi.fn(async () => null),
		searchLlmSpans: vi.fn(async () => []),
		searchLogs: vi.fn(async () => [])
	};
	return {
		order,
		authorization,
		authority,
		workspaces,
		queries,
		service: new ApplicationPreviewWorkflowDiagnosticsBrokerService({
			authorization,
			authority: authority as never,
			workspaces,
			queries
		})
	};
}

describe('preview workflow diagnostics broker', () => {
	it('authorizes proof, tuple owner, and physical workspace before querying', async () => {
		const h = harness();
		await h.service.execute(command());

		expect(h.order).toEqual(['proof', 'tuple', 'workspace', 'query']);
		expect(h.authorization.verify).toHaveBeenCalledWith('proof', {
			identity,
			execution: {
				id: 'execution-1',
				userId: 'user-1',
				projectId: 'project-1',
				startedAt: new Date('2026-07-19T12:00:00.000Z'),
				completedAt: new Date('2026-07-19T12:01:00.000Z'),
				primaryTraceId: null,
				workflowSessionId: null
			},
			operation: 'resolve-trace-ids'
		});
	});

	it('fails closed before telemetry when the execution proof or owner is wrong', async () => {
		const h = harness();
		h.authorization.verify.mockReturnValueOnce(false);
		await expect(h.service.execute(command())).rejects.toBeInstanceOf(
			PreviewWorkflowDiagnosticsError
		);
		expect(h.authority.authorizeTraceTuple).not.toHaveBeenCalled();
		expect(h.queries.resolveTraceIds).not.toHaveBeenCalled();

		h.authorization.verify.mockReturnValueOnce(true);
		h.authority.authorizeTraceTuple.mockResolvedValueOnce({ owner: 'user-2' } as never);
		await expect(h.service.execute(command())).rejects.toMatchObject({
			code: 'not-authorized'
		});
		expect(h.queries.resolveTraceIds).not.toHaveBeenCalled();
	});

	it('overwrites LLM execution correlation and rejects unbounded query input', async () => {
		const h = harness();
		await h.service.execute(
			command('search-llm-spans', {
				traceIds: ['a'.repeat(32)],
				spanId: 'b'.repeat(16),
				limit: 2,
				offset: 0
			})
		);
		expect(h.queries.searchLlmSpans).toHaveBeenCalledWith(
			expect.objectContaining({
				query: expect.objectContaining({ workflowExecutionId: 'execution-1' })
			})
		);

		await expect(
			h.service.execute(
				command('search-spans', {
					traceIds: [],
					limit: 1_000,
					offset: 0,
					sql: 'select *'
				})
			)
		).rejects.toMatchObject({ code: 'invalid-request' });
	});
});
