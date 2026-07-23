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
			return { owner: 'physical-admin-1' };
		})
	};
	const queries = {
		isConfigured: vi.fn(() => true),
		loadDigestTelemetry: vi.fn(async () => ({
			traceIds: [], spans: [], llmSpans: [], llmSpansTruncated: false,
			llmSpanLimit: 2_000, degradedSources: [], warnings: []
		})),
		loadInvestigationEvidence: vi.fn(async ({ request }) => ({
			traceIds: [],
			traceSpans: [],
			logs: [],
			llmSpans: [],
			toolSpans: [],
			truncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			rowTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			contentTruncated: {
				spans: false,
				logs: false,
				llmSpans: false,
				toolSpans: false
			},
			limits: request.limits,
			degradedSources: [],
			warnings: []
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
		queries,
		service: new ApplicationPreviewWorkflowDiagnosticsBrokerService({
			authorization,
			authority: authority as never,
			queries
		})
	};
}

describe('preview workflow diagnostics broker', () => {
	it('authorizes the preview-local execution proof and physical tuple before querying', async () => {
		const h = harness();
		await h.service.execute(command());

		expect(h.order).toEqual(['proof', 'tuple', 'query']);
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

	it('accepts preview-local principals that differ from the physical lifecycle owner', async () => {
		const h = harness();
		await expect(h.service.execute(command())).resolves.toEqual({ traceIds: [], warnings: [] });

		expect(h.authority.authorizeTraceTuple).toHaveBeenCalledWith(identity);
		expect(h.queries.resolveTraceIds).toHaveBeenCalledOnce();
	});

	it('fails closed before telemetry when the execution proof or physical tuple is invalid', async () => {
		const h = harness();
		h.authorization.verify.mockReturnValueOnce(false);
		await expect(h.service.execute(command())).rejects.toBeInstanceOf(
			PreviewWorkflowDiagnosticsError
		);
		expect(h.authority.authorizeTraceTuple).not.toHaveBeenCalled();
		expect(h.queries.resolveTraceIds).not.toHaveBeenCalled();

		h.authorization.verify.mockReturnValueOnce(true);
		h.authority.authorizeTraceTuple.mockRejectedValueOnce(new Error('tuple mismatch'));
		await expect(h.service.execute(command())).rejects.toThrow('tuple mismatch');
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

	it('accepts only explicitly bounded investigation categories and scope', async () => {
		const h = harness();
		await h.service.execute(
			command('investigation-evidence', {
				categories: ['spans', 'logs'],
				serviceNames: ['agent-runtime'],
				limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 }
			})
		);

		expect(h.queries.loadInvestigationEvidence).toHaveBeenCalledWith({
			identity,
			execution: command().execution,
			request: {
				categories: ['spans', 'logs'],
				serviceNames: ['agent-runtime'],
				limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 }
			}
		});

		await expect(
			h.service.execute(
				command('investigation-evidence', {
					categories: ['spans'],
					serviceNames: [],
					limits: { spans: 201, logs: 20, llmSpans: 5, toolSpans: 10 }
				})
			)
		).rejects.toMatchObject({ code: 'invalid-request' });
	});
});
