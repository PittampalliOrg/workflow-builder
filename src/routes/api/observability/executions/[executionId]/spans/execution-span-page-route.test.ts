import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	encodePageCursor,
	pageCursorScope
} from '$lib/server/application/diagnostic-pagination';

const mocks = vi.hoisted(() => {
	const execution = {
		id: 'execution-1',
		userId: 'user-1',
		projectId: 'project-1',
		status: 'error',
		startedAt: new Date('2026-07-19T12:00:00.000Z'),
		completedAt: new Date('2026-07-19T12:01:00.000Z')
	};
	const getContext = vi.fn(async () => ({ execution }));
	const searchSpans = vi.fn(async () => ({
		body: {
			spans: [{ traceId: 'a'.repeat(32), spanId: '1'.repeat(16) }],
			page: { limit: 100, count: 1, truncated: false, nextCursor: null }
		}
	}));
	const getApplicationAdapters = vi.fn(() => ({
		workflowData: { getObservabilityServiceGraphContext: getContext },
		workflowDiagnostics: { searchSpans }
	}));
	return { execution, getContext, searchSpans, getApplicationAdapters };
});

vi.mock('$lib/server/application', () => ({
	getApplicationAdapters: mocks.getApplicationAdapters
}));

import { GET } from './+server';

function event(options: { session?: { userId: string; projectId: string | null } | null; cursor?: string } = {}) {
	const url = new URL('http://localhost/api/observability/executions/execution-1/spans');
	if (options.cursor) url.searchParams.set('cursor', options.cursor);
	return {
		params: { executionId: 'execution-1' },
		locals: {
			session:
				options.session === undefined
					? { userId: 'user-1', projectId: 'project-1' }
					: options.session
		},
		url
	};
}

describe('execution span continuation route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getContext.mockResolvedValue({ execution: mocks.execution });
	});

	it('requires a user session before application composition', async () => {
		await expect(GET(event({ session: null }) as never)).rejects.toMatchObject({ status: 401 });
		expect(mocks.getApplicationAdapters).not.toHaveBeenCalled();
	});

	it('scope-validates the execution and continues from a server-issued cursor', async () => {
		const scope = pageCursorScope('public-execution-spans', {
			executionId: 'execution-1',
			query: '',
			errorsOnly: false,
			limit: 100
		});
		const cursor = encodePageCursor(200, scope)!;

		const response = (await GET(event({ cursor }) as never)) as Response;

		expect(mocks.getContext).toHaveBeenCalledExactlyOnceWith({
			userId: 'user-1',
			projectId: 'project-1',
			executionId: 'execution-1'
		});
		expect(mocks.searchSpans).toHaveBeenCalledWith(
			expect.objectContaining({
				execution: mocks.execution,
				query: '',
				errorsOnly: false,
				limit: 100,
				offset: 200
			})
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		await expect(response.json()).resolves.toMatchObject({
			spans: [{ spanId: '1'.repeat(16) }]
		});
	});

	it('rejects a cursor minted for another execution', async () => {
		const wrongScope = pageCursorScope('public-execution-spans', {
			executionId: 'execution-2',
			query: '',
			errorsOnly: false,
			limit: 100
		});
		const response = (await GET(
			event({ cursor: encodePageCursor(200, wrongScope)! }) as never
		)) as Response;

		expect(response.status).toBe(400);
		expect(mocks.searchSpans).not.toHaveBeenCalled();
	});
});
