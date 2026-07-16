import { error } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	isClickHouseConfigured: vi.fn(),
	getTraceSpanDetail: vi.fn(),
	assertTraceInScope: vi.fn()
}));

vi.mock('$lib/server/otel/clickhouse', () => ({
	isClickHouseConfigured: mocks.isClickHouseConfigured,
	getTraceSpanDetail: mocks.getTraceSpanDetail
}));

vi.mock('../../trace-access', () => ({
	assertTraceInScope: mocks.assertTraceInScope
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
		mocks.isClickHouseConfigured.mockReturnValue(true);
		mocks.assertTraceInScope.mockResolvedValue(undefined);
		mocks.getTraceSpanDetail.mockResolvedValue({
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
		expect(mocks.assertTraceInScope).toHaveBeenCalledWith('trace-1', { userId: 'user-1' });
		expect(mocks.getTraceSpanDetail).toHaveBeenCalledWith('trace-1', 'span-1');
		expect(body.span.attributes).toEqual({ 'input.value': 'full payload' });
	});

	it('returns 503 without querying when ClickHouse is not configured', async () => {
		mocks.isClickHouseConfigured.mockReturnValue(false);

		const response = await request();

		expect(response.status).toBe(503);
		expect(mocks.assertTraceInScope).not.toHaveBeenCalled();
		expect(mocks.getTraceSpanDetail).not.toHaveBeenCalled();
	});

	it('preserves deliberate scope errors', async () => {
		mocks.assertTraceInScope.mockImplementation(() => error(403, 'Forbidden'));

		await expect(request()).rejects.toMatchObject({ status: 403 });
		expect(mocks.getTraceSpanDetail).not.toHaveBeenCalled();
	});

	it('distinguishes a missing span from a ClickHouse failure', async () => {
		mocks.getTraceSpanDetail.mockResolvedValueOnce(null);
		await expect(request()).rejects.toMatchObject({ status: 404 });

		mocks.getTraceSpanDetail.mockRejectedValueOnce(new Error('timeout'));
		const response = await request();
		const body = await response.json();

		expect(response.status).toBe(503);
		expect(body.error).toContain('timeout');
	});
});
