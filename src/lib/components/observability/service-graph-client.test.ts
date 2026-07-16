import { describe, expect, it, vi } from 'vitest';
import { fetchServiceGraphPayload, ServiceGraphRequestError } from './service-graph-client';

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

describe('service graph client', () => {
	it('returns a validated graph payload', async () => {
		const payload = {
			mode: 'step',
			scope: 'execution',
			executionId: 'exec-1',
			nodes: [],
			edges: [],
			meta: { spanCount: 0, traceCount: 0, warnings: [] }
		};
		const fetcher = vi.fn(async () => response(payload));

		await expect(fetchServiceGraphPayload('/graph', { fetcher })).resolves.toEqual(payload);
	});

	it('surfaces the API message and status instead of treating an error body as graph data', async () => {
		const fetcher = vi.fn(async () => response({ message: 'Execution not found' }, 404));

		await expect(fetchServiceGraphPayload('/graph', { fetcher })).rejects.toMatchObject({
			name: 'ServiceGraphRequestError',
			message: 'Execution not found',
			status: 404
		} satisfies Partial<ServiceGraphRequestError>);
	});

	it('rejects malformed successful responses', async () => {
		const fetcher = vi.fn(async () => response({ message: 'not a graph' }));

		await expect(fetchServiceGraphPayload('/graph', { fetcher })).rejects.toThrow(
			'Service graph returned an invalid response'
		);
	});
});
