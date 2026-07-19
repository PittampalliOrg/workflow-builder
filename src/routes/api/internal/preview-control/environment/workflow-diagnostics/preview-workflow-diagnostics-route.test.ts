import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	env: { PREVIEW_CONTROL_BROKER_MODE: 'true' },
	requireCapability: vi.fn(),
	execute: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: mocks.env }));
vi.mock('$lib/server/internal-auth', () => ({
	requirePreviewControlCapability: mocks.requireCapability
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		previewWorkflowDiagnosticsBroker: { execute: mocks.execute }
	})
}));

import { POST } from './+server';

const identity = {
	previewName: 'feature-one',
	environmentRequestId: 'request-1',
	environmentPlatformRevision: 'a'.repeat(40),
	environmentSourceRevision: 'b'.repeat(40),
	catalogDigest: `sha256:${'c'.repeat(64)}`
};
const execution = {
	id: 'execution-1',
	userId: 'user-1',
	projectId: 'project-1',
	status: 'error',
	startedAt: '2026-07-19T12:00:00.000Z',
	completedAt: '2026-07-19T12:01:00.000Z',
	primaryTraceId: 'a'.repeat(32),
	workflowSessionId: 'session-1'
};

function event(body: unknown) {
	return {
		request: new Request(
			'http://broker/api/internal/preview-control/environment/workflow-diagnostics',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			}
		)
	};
}

describe('physical preview workflow diagnostics route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.env.PREVIEW_CONTROL_BROKER_MODE = 'true';
		mocks.execute.mockResolvedValue({ traceIds: [], warnings: [] });
	});

	it('requires the exact tuple leaf before the authorized broker use case', async () => {
		const response = (await POST(
			event({
				identity,
				authorization: 'proof',
				operation: 'resolve-trace-ids',
				execution,
				request: {}
			}) as never
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.requireCapability).toHaveBeenCalledWith(expect.any(Request), identity);
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				identity,
				authorization: 'proof',
				operation: 'resolve-trace-ids',
				execution: expect.objectContaining({
					id: 'execution-1',
					userId: 'user-1',
					projectId: 'project-1'
				})
			})
		);
	});

	it('rejects missing workspace scope and caller-authored authority fields', async () => {
		const missingProject = await POST(
			event({
				identity,
				authorization: 'proof',
				operation: 'resolve-trace-ids',
				execution: { ...execution, projectId: null },
				request: {}
			}) as never
		);
		expect(missingProject.status).toBe(400);

		const extra = await POST(
			event({
				identity,
				authorization: 'proof',
				operation: 'resolve-trace-ids',
				execution,
				request: {},
				sql: 'select *',
				workspaceKey: 'secret'
			}) as never
		);
		expect(extra.status).toBe(400);
		expect(mocks.execute).not.toHaveBeenCalled();
	});

	it('is absent outside the physical broker deployment', async () => {
		mocks.env.PREVIEW_CONTROL_BROKER_MODE = 'false';
		const response = await POST(
			event({ identity, authorization: 'proof', operation: 'resolve-trace-ids', execution, request: {} }) as never
		);
		expect(response.status).toBe(404);
		expect(mocks.requireCapability).not.toHaveBeenCalled();
	});
});
