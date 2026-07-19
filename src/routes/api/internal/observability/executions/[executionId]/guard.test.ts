import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const execution = {
		id: 'exec-1',
		workflowId: 'workflow-1',
		userId: 'user-1',
		projectId: 'project-1'
	};
	const getScopedExecutionById = vi.fn(
		async (): Promise<typeof execution | null> => execution
	);
	const internalWorkflowPrincipal = { authorize: vi.fn() };
	const resolveInternalWorkflowPrincipal = vi.fn(async () => ({
		ok: true as const,
		principal: {
			userId: 'user-1',
			projectId: 'project-1',
			sessionId: null,
			scopes: ['workflow:read']
		}
	}));
	const validateInternalToken = vi.fn(() => true);

	return {
		execution,
		getScopedExecutionById,
		internalWorkflowPrincipal,
		resolveInternalWorkflowPrincipal,
		validateInternalToken
	};
});

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: () => ({
		workflowData: { getScopedExecutionById: mocks.getScopedExecutionById },
		internalWorkflowPrincipal: mocks.internalWorkflowPrincipal
	})
}));

vi.mock('$lib/server/internal-auth', () => ({
	validateInternalToken: mocks.validateInternalToken
}));

vi.mock('../../../workflow-mcp-principal', () => ({
	resolveInternalWorkflowPrincipal: mocks.resolveInternalWorkflowPrincipal
}));

import { guardAnalystAccess } from './guard';

function request() {
	return new Request('http://localhost/api/internal/observability/executions/exec-1/digest', {
		headers: {
			'X-Internal-Token': 'internal-token',
			'X-Wfb-Principal-Assertion': 'signed-principal'
		}
	});
}

describe('internal observability execution guard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.getScopedExecutionById.mockResolvedValue(mocks.execution);
		mocks.resolveInternalWorkflowPrincipal.mockResolvedValue({
			ok: true,
			principal: {
				userId: 'user-1',
				projectId: 'project-1',
				sessionId: null,
				scopes: ['workflow:read']
			}
		});
	});

	it('keeps authorization and execution ownership behind application ports', () => {
		const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'guard.ts'), 'utf8');

		expect(source).toContain('resolveInternalWorkflowPrincipal');
		expect(source).toContain('workflowData.getScopedExecutionById');
		expect(source).not.toContain('getSessionFileOwner');
		expect(source).not.toContain('getObservabilityServiceGraphContext');
		expect(source).not.toContain('$lib/server/db');
		expect(source).not.toContain('drizzle-orm');
	});

	it('rejects an invalid service token before principal or data access', async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		const result = await guardAnalystAccess(request(), 'exec-1');

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected access denial');
		expect(result.res.status).toBe(401);
		await expect(result.res.json()).resolves.toEqual({ error: 'unauthorized' });
		expect(mocks.resolveInternalWorkflowPrincipal).not.toHaveBeenCalled();
		expect(mocks.getScopedExecutionById).not.toHaveBeenCalled();
	});

	it('authorizes a signed sessionless principal with workflow read scope', async () => {
		const req = request();

		const result = await guardAnalystAccess(req, 'exec-1');

		expect(req.headers.has('x-wfb-session-id')).toBe(false);
		expect(mocks.resolveInternalWorkflowPrincipal).toHaveBeenCalledWith(
			req,
			mocks.internalWorkflowPrincipal,
			{ requiredScope: 'workflow:read' }
		);
		expect(mocks.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: 'exec-1',
			userId: 'user-1',
			projectId: 'project-1'
		});
		expect(result).toEqual({ ok: true, execution: mocks.execution });
	});

	it('returns the principal authorization failure before data access', async () => {
		mocks.resolveInternalWorkflowPrincipal.mockResolvedValueOnce({
			ok: false,
			status: 403,
			error: 'Missing required scope: workflow:read'
		} as never);

		const result = await guardAnalystAccess(request(), 'exec-1');

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected access denial');
		expect(result.res.status).toBe(403);
		await expect(result.res.json()).resolves.toEqual({
			error: 'Missing required scope: workflow:read'
		});
		expect(mocks.getScopedExecutionById).not.toHaveBeenCalled();
	});

	it('does not reveal an execution outside the principal workspace', async () => {
		mocks.getScopedExecutionById.mockResolvedValueOnce(null);

		const result = await guardAnalystAccess(request(), 'exec-other');

		expect(mocks.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: 'exec-other',
			userId: 'user-1',
			projectId: 'project-1'
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected access denial');
		expect(result.res.status).toBe(404);
		await expect(result.res.json()).resolves.toEqual({
			error: 'Execution exec-other not found in this workspace'
		});
	});
});
