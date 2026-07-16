import { error } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	isTraceSpanDetailConfigured: vi.fn(),
	getTraceSpanDetailInScope: vi.fn()
}));

vi.mock('../../trace-access', () => ({
	isTraceSpanDetailConfigured: mocks.isTraceSpanDetailConfigured,
	getTraceSpanDetailInScope: mocks.getTraceSpanDetailInScope
}));

import { GET } from './+server';

function request() {
	return GET({
		params: { traceId: 'trace-1', spanId: 'span-1' },
		locals: { session: { userId: 'user-1' } }
	} as never);
}

describe('observability span detail route', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isTraceSpanDetailConfigured.mockReturnValue(true);
		mocks.getTraceSpanDetailInScope.mockResolvedValue({
			traceId: 'trace-1',
			spanId: 'span-1',
			operationName: 'agent.run',
			serviceName: 'agent-runtime',
			duration: 42,
			status: 'ok',
			startTime: '2026-07-16T00:00:00.000Z',
			attributes: { 'input.value': 'full payload' },
			depth: 0
		});
	});

	it('returns one complete span after checking trace scope', async () => {
		const response = await request();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.getTraceSpanDetailInScope).toHaveBeenCalledWith({
			traceId: 'trace-1',
			spanId: 'span-1',
			session: { userId: 'user-1' }
		});
		expect(body.span.attributes).toEqual({ 'input.value': 'full payload' });
	});

	it('returns 503 without querying when ClickHouse is not configured', async () => {
		mocks.isTraceSpanDetailConfigured.mockReturnValue(false);

		const response = await request();

		expect(response.status).toBe(503);
		expect(mocks.getTraceSpanDetailInScope).not.toHaveBeenCalled();
	});

	it('preserves deliberate scope errors', async () => {
		mocks.getTraceSpanDetailInScope.mockImplementation(() => error(403, 'Forbidden'));

		await expect(request()).rejects.toMatchObject({ status: 403 });
		expect(mocks.getTraceSpanDetailInScope).toHaveBeenCalledOnce();
	});

	it('distinguishes a missing span from a ClickHouse failure', async () => {
		mocks.getTraceSpanDetailInScope.mockResolvedValueOnce(null);
		await expect(request()).rejects.toMatchObject({ status: 404 });

		mocks.getTraceSpanDetailInScope.mockRejectedValueOnce(new Error('timeout'));
		const response = await request();
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body.error).toContain('timeout');
	});
});
