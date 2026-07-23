import { describe, expect, it, vi } from 'vitest';
import type {
	PreviewControlIdentity,
	WorkflowDiagnosticsExecution
} from '$lib/server/application/ports';
import {
	HttpPreviewWorkflowDiagnosticsReadAdapter,
	PreviewWorkflowDiagnosticsTransportError
} from './preview-workflow-diagnostics-http';

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
	output: { api_key: 'must-stay-local' },
	executionIr: { budgetTotal: 100 },
	primaryTraceId: 'a'.repeat(32),
	workflowSessionId: 'session-1'
};

describe('preview workflow diagnostics HTTP adapter', () => {
	it('forwards only signed correlation metadata through the tuple leaf', async () => {
		const issue = vi.fn(() => 'execution-proof');
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(JSON.stringify(body)).not.toContain('must-stay-local');
			expect(body.execution).not.toHaveProperty('output');
			expect(body.execution).not.toHaveProperty('executionIr');
			return new Response(
				JSON.stringify({
					ok: true,
					identity,
					result: { traceIds: ['a'.repeat(32)], warnings: [] }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000/',
			identity: () => identity,
			credential: () => ({
				header: 'X-Preview-Control-Capability',
				token: 'd'.repeat(64)
			}),
			authorization: { issue, verify: vi.fn(() => false) },
			fetch: fetchImpl as typeof fetch
		});

		await expect(adapter.resolveTraceIds(execution)).resolves.toEqual({
			traceIds: ['a'.repeat(32)],
			warnings: []
		});
		expect(issue).toHaveBeenCalledWith({
			identity,
			execution,
			operation: 'resolve-trace-ids'
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			'http://preview-control-broker:3000/api/internal/preview-control/environment/workflow-diagnostics',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					'X-Preview-Control-Capability': 'd'.repeat(64)
				})
			})
		);
	});

	it('rejects a receipt from another immutable generation', async () => {
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({ header: 'x-preview-control-capability', token: 'd'.repeat(64) }),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: vi.fn(async () =>
				new Response(
					JSON.stringify({
						ok: true,
						identity: { ...identity, environmentRequestId: 'request-2' },
						result: { traceIds: [], warnings: [] }
					}),
					{ status: 200 }
				)
			) as typeof fetch
		});

		await expect(adapter.resolveTraceIds(execution)).rejects.toBeInstanceOf(
			PreviewWorkflowDiagnosticsTransportError
		);
	});

	it('brokers an explicitly bounded investigation request without product data', async () => {
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.operation).toBe('investigation-evidence');
			expect(body.request).toEqual({
				categories: ['spans', 'logs'],
				serviceNames: ['agent-runtime'],
				limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 }
			});
			expect(body.execution).not.toHaveProperty('output');
			return new Response(
				JSON.stringify({
					ok: true,
					identity,
					result: {
						traceIds: ['a'.repeat(32)],
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
						limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 },
						degradedSources: [],
						warnings: []
					}
				}),
				{ status: 200 }
			);
		});
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({
				header: 'x-preview-control-capability',
				token: 'd'.repeat(64)
			}),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: fetchImpl as typeof fetch
		});

		await expect(
			adapter.loadInvestigationEvidence(execution, {
				categories: ['spans', 'logs'],
				serviceNames: ['agent-runtime'],
				limits: { spans: 10, logs: 20, llmSpans: 5, toolSpans: 10 }
			})
		).resolves.toMatchObject({
			traceIds: ['a'.repeat(32)],
			limits: { spans: 10 }
		});
	});

	it('rejects broker evidence beyond the transport response cap', async () => {
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({ header: 'x-preview-control-capability', token: 'd'.repeat(64) }),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: vi.fn(async () =>
				new Response('', {
					status: 200,
					headers: { 'content-length': String(4 * 1024 * 1024 + 1) }
				})
			) as typeof fetch
		});

		await expect(adapter.resolveTraceIds(execution)).rejects.toThrow(
			'preview diagnostics broker response is too large'
		);
	});

	it('uses the broker sentinel to report rows beyond a full span-summary budget', async () => {
		const requests: Array<{ traceIds: string[]; limit: number; offset: number }> = [];
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const request = body.request as { traceIds: string[]; limit: number; offset: number };
			requests.push(request);
			return new Response(
				JSON.stringify({
					ok: true,
					identity,
					result: Array.from({ length: request.limit }, (_, index) => ({
						spanId: `span-${request.offset + index}`
					}))
				}),
				{ status: 200 }
			);
		});
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({ header: 'x-preview-control-capability', token: 'd'.repeat(64) }),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: fetchImpl as typeof fetch
		});

		const result = await adapter.loadSpanSummaries(execution, ['a'.repeat(32)], 250);

		expect(requests).toEqual([
			{ traceIds: ['a'.repeat(32)], limit: 101, offset: 0 },
			{ traceIds: ['a'.repeat(32)], limit: 101, offset: 100 },
			{ traceIds: ['a'.repeat(32)], limit: 51, offset: 200 }
		]);
		expect(result.spans).toHaveLength(250);
		expect(result.spans.at(-1)).toMatchObject({ spanId: 'span-249' });
		expect(result.truncated).toBe(true);
	});

	it('does not report truncation when the span-summary total exactly fills the budget', async () => {
		const total = 250;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const request = body.request as { limit: number; offset: number };
			const count = Math.max(0, Math.min(request.limit, total - request.offset));
			return new Response(
				JSON.stringify({
					ok: true,
					identity,
					result: Array.from({ length: count }, (_, index) => ({
						spanId: `span-${request.offset + index}`
					}))
				}),
				{ status: 200 }
			);
		});
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({ header: 'x-preview-control-capability', token: 'd'.repeat(64) }),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: fetchImpl as typeof fetch
		});

		const result = await adapter.loadSpanSummaries(execution, ['a'.repeat(32)], total);

		expect(result.spans).toHaveLength(total);
		expect(result.truncated).toBe(false);
	});

	it('stops span-summary pagination on a short page without reporting truncation', async () => {
		const requests: Array<{ limit: number; offset: number }> = [];
		const total = 215;
		const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			const request = body.request as { limit: number; offset: number };
			requests.push(request);
			const count = Math.max(0, Math.min(request.limit, total - request.offset));
			return new Response(
				JSON.stringify({
					ok: true,
					identity,
					result: Array.from({ length: count }, (_, index) => ({
						spanId: `span-${request.offset + index}`
					}))
				}),
				{ status: 200 }
			);
		});
		const adapter = new HttpPreviewWorkflowDiagnosticsReadAdapter({
			listScriptCalls: async () => [],
			baseUrl: () => 'http://preview-control-broker:3000',
			identity: () => identity,
			credential: () => ({ header: 'x-preview-control-capability', token: 'd'.repeat(64) }),
			authorization: { issue: () => 'proof', verify: () => false },
			fetch: fetchImpl as typeof fetch
		});

		const result = await adapter.loadSpanSummaries(execution, ['a'.repeat(32)], 500);

		expect(requests.map(({ limit, offset }) => ({ limit, offset }))).toEqual([
			{ limit: 101, offset: 0 },
			{ limit: 101, offset: 100 },
			{ limit: 101, offset: 200 }
		]);
		expect(result.spans).toHaveLength(total);
		expect(result.truncated).toBe(false);
	});
});
