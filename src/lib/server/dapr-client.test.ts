import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: {} }));

import { responseBodyForSpan } from './dapr-client';

describe('dapr client observability helpers', () => {
	it('does not consume event-stream responses while building span output', async () => {
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('event: heartbeat\\n\\n'));
			}
		});
		const response = new Response(stream, {
			headers: { 'content-type': 'text/event-stream' }
		});

		await expect(responseBodyForSpan(response)).resolves.toEqual({
			status: 200,
			contentType: 'text/event-stream',
			body: '[streaming response omitted]'
		});
		expect(response.bodyUsed).toBe(false);
	});
});
