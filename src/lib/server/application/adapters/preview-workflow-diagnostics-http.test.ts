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
});
