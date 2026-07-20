import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const execution = { id: 'execution-1' };
	const getContext = vi.fn(async () => ({ execution }));
	const getSpan = vi.fn(async () => ({
		body: {
			span: {
				traceId: 'a'.repeat(32),
				spanId: '1'.repeat(16),
				operationName: 'agent.run',
				serviceName: 'agent-runtime',
				attributes: {},
				attributesTruncated: true
			}
		}
	}));
	const getApplicationAdapters = vi.fn(() => ({
		workflowData: { getObservabilityServiceGraphContext: getContext },
		workflowDiagnostics: { getSpan }
	}));
	return { execution, getContext, getSpan, getApplicationAdapters };
});

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: mocks.getApplicationAdapters
}));

import { GET } from './+server';

function event(session: { userId: string; projectId: string | null } | null = {
	userId: 'user-1',
	projectId: 'project-1'
}) {
	return {
		params: { executionId: 'execution-1', spanId: '1'.repeat(16) },
		locals: { session }
	};
}

describe('execution span detail route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getContext.mockResolvedValue({ execution: mocks.execution });
	});

	it('requires authentication and workspace-scopes the execution', async () => {
		await expect(GET(event(null) as never)).rejects.toMatchObject({ status: 401 });
		expect(mocks.getApplicationAdapters).not.toHaveBeenCalled();

		mocks.getContext.mockResolvedValueOnce(null as never);
		await expect(GET(event() as never)).rejects.toMatchObject({ status: 404 });
		expect(mocks.getSpan).not.toHaveBeenCalled();
	});

	it('passes through the canonical span shape and truncation state', async () => {
		const response = (await GET(event() as never)) as Response;
		await expect(response.json()).resolves.toMatchObject({
			span: {
				operationName: 'agent.run',
				serviceName: 'agent-runtime',
				attributesTruncated: true
			}
		});
		expect(mocks.getSpan).toHaveBeenCalledWith({
			execution: mocks.execution,
			spanId: '1'.repeat(16)
		});
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
