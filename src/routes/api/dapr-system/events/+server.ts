import type { RequestHandler } from './$types';
import { daprEventStream } from '$lib/server/dapr-event-stream';

/**
 * SSE endpoint for live Dapr pub/sub event streaming.
 *
 * GET /api/dapr-system/events?since=0
 *
 * Streams all pub/sub events received by this app's sidecar in real-time.
 * The `since` param sends buffered events with id > since first, then streams live.
 */
export const GET: RequestHandler = async ({ url }) => {
	const sinceId = parseInt(url.searchParams.get('since') || '0');

	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();

			const send = (data: string) => {
				try {
					controller.enqueue(encoder.encode(data));
				} catch {
					// stream closed
				}
			};

			// Send recent buffered events first
			const recent = daprEventStream.getRecent(100);
			for (const event of recent) {
				if (event.id > sinceId) {
					send(`id: ${event.id}\nevent: dapr-event\ndata: ${JSON.stringify(event)}\n\n`);
				}
			}

			// Subscribe to live events
			const unsubscribe = daprEventStream.subscribe((event) => {
				send(`id: ${event.id}\nevent: dapr-event\ndata: ${JSON.stringify(event)}\n\n`);
			});

			// Send heartbeat every 15s to keep connection alive
			const heartbeat = setInterval(() => {
				send(`: heartbeat\n\n`);
			}, 15000);

			// Cleanup when client disconnects
			const cleanup = () => {
				unsubscribe();
				clearInterval(heartbeat);
			};

			// The stream will be cancelled when the client disconnects
			// We need to handle this via the cancel callback
			return cleanup;
		},
		cancel() {
			// Client disconnected — cleanup happens via the returned function from start
		}
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive'
		}
	});
};
