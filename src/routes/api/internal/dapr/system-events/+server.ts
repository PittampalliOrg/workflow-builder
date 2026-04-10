import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprEventStream } from '$lib/server/dapr-event-stream';

/**
 * Dapr pub/sub catch-all event handler for the Dapr System dashboard.
 *
 * Receives events from subscribed topics and pushes them into the
 * daprEventStream for live SSE streaming to the dashboard.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		// Extract CloudEvents fields
		const topic = body.topic ?? body.pubsubname ?? 'unknown';
		const type = body.type ?? body.data?.type ?? 'unknown';
		const source = body.source ?? '';
		const data = body.data ?? body;

		daprEventStream.push(topic, type, source, data);
	} catch {
		// Malformed event — ignore
	}

	// Always return SUCCESS to acknowledge the message
	return json({ status: 'SUCCESS' });
};
