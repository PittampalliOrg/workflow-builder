import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	validateInternalToken: vi.fn(() => true),
	resolveInternalWorkflowPrincipal: vi.fn(async () => ({
		ok: true as const,
		principal: { userId: 'user-1', projectId: 'project-1', scopes: ['workflow:read'] }
	})),
	workflowData: {
		getScopedWorkflowById: vi.fn(
			async (): Promise<{ id: string } | null> => ({ id: 'workflow-1' })
		),
		getScopedWorkflowByName: vi.fn(
			async (): Promise<{ id: string } | null> => ({ id: 'workflow-1' })
		),
		listProjectWorkflowRuns: vi.fn(async () => [
			{
				executionId: 'execution-1',
				workflowId: 'workflow-1',
				workflowName: 'Example',
				status: 'error',
				startedAt: '2026-07-19T12:00:00.000Z',
				completedAt: '2026-07-19T12:01:00.000Z',
				durationMs: 60_000,
				sessionCount: 1,
				agents: []
			}
		])
	},
	internalWorkflowPrincipal: { authorize: vi.fn() }
}));

vi.mock('$lib/server/internal-auth', () => ({
	validateInternalToken: mocks.validateInternalToken
}));
vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		internalWorkflowPrincipal: mocks.internalWorkflowPrincipal
	})
}));
vi.mock('../../workflow-mcp-principal', () => ({
	resolveInternalWorkflowPrincipal: mocks.resolveInternalWorkflowPrincipal
}));

import { GET } from './+server';

function event(query = '') {
	return {
		request: new Request(`http://localhost/api/internal/observability/executions${query}`, {
			headers: {
				'X-Internal-Token': 'internal',
				'X-Wfb-Principal-Assertion': 'signed-principal'
			}
		}),
		url: new URL(`http://localhost/api/internal/observability/executions${query}`)
	};
}

describe('internal observability execution discovery', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.getScopedWorkflowById.mockResolvedValue({ id: 'workflow-1' });
		mocks.workflowData.listProjectWorkflowRuns.mockResolvedValue([
			{
				executionId: 'execution-1',
				workflowId: 'workflow-1',
				workflowName: 'Example',
				status: 'error',
				startedAt: '2026-07-19T12:00:00.000Z',
				completedAt: '2026-07-19T12:01:00.000Z',
				durationMs: 60_000,
				sessionCount: 1,
				agents: []
			}
		]);
	});

	it('lists only project-scoped runs for a scoped workflow', async () => {
		const response = (await GET(event('?workflowId=workflow-1&status=error&limit=10') as never)) as Response;
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			executions: [{ executionId: 'execution-1', workflowId: 'workflow-1', status: 'error' }],
			page: { limit: 10, count: 1, truncated: false, nextCursor: null }
		});
		expect(mocks.workflowData.getScopedWorkflowById).toHaveBeenCalledWith({
			workflowId: 'workflow-1',
			userId: 'user-1',
			projectId: 'project-1'
		});
		expect(mocks.workflowData.listProjectWorkflowRuns).toHaveBeenCalledWith({
			projectId: 'project-1',
			workflowId: 'workflow-1',
			status: 'error',
			limit: 11,
			offset: 0
		});
	});

	it('returns not found rather than leaking a foreign workflow', async () => {
		mocks.workflowData.getScopedWorkflowById.mockResolvedValueOnce(null);
		await expect(GET(event('?workflowId=foreign') as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.workflowData.listProjectWorkflowRuns).not.toHaveBeenCalled();
	});

	it('requires a valid signed workflow principal', async () => {
		mocks.resolveInternalWorkflowPrincipal.mockResolvedValueOnce({
			ok: false,
			status: 403,
			error: 'Missing workflow:read'
		} as never);
		await expect(GET(event() as never)).rejects.toMatchObject({ status: 403 });
		expect(mocks.workflowData.listProjectWorkflowRuns).not.toHaveBeenCalled();
	});
});
