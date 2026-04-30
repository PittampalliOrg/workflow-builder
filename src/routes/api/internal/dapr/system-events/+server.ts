import { json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { daprEventStream } from '$lib/server/dapr-event-stream';
import { db } from '$lib/server/db';
import { sessions } from '$lib/server/db/schema';
import { appendEvent } from '$lib/server/sessions/events';

/**
 * Dapr pub/sub catch-all event handler.
 *
 * Two responsibilities:
 *  1. Push every event into `daprEventStream` for the Dapr System dashboard.
 *  2. For `workflow-state-events` (Dapr workflow lifecycle), correlate the
 *     instanceId to a session and append a `workflow.state` event to the
 *     session's timeline so the run-detail page sees it on the same SSE
 *     stream as agent events. No NATS consumer or orchestrator change
 *     needed — Dapr already delivers via the existing Subscription CRD
 *     (`packages/components/active-development/manifests/workflow-builder/Subscription-system-events.yaml`).
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		// Malformed event — ack and drop
		return json({ status: 'SUCCESS' });
	}

	// Extract CloudEvents fields
	const topic = (body.topic as string | undefined) ?? (body.pubsubname as string | undefined) ?? 'unknown';
	const dataObj = (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : body) as Record<
		string,
		unknown
	>;
	const type = (body.type as string | undefined) ?? (dataObj.type as string | undefined) ?? 'unknown';
	const source = (body.source as string | undefined) ?? '';

	daprEventStream.push(topic, type, source, dataObj);

	if (topic === 'workflow-state-events' && db) {
		// Best-effort bridge: failures must not NACK the Dapr message
		try {
			const instanceId =
				(dataObj.instance_id as string | undefined) ??
				(dataObj.instanceId as string | undefined) ??
				(dataObj.workflow_instance_id as string | undefined);
			if (instanceId) {
				const [sessionRow] = await db
					.select({ id: sessions.id })
					.from(sessions)
					.where(eq(sessions.daprInstanceId, instanceId))
					.limit(1);
				if (sessionRow?.id) {
					const eventId = (body.id as string | undefined) ?? (dataObj.event_id as string | undefined) ?? null;
					await appendEvent(sessionRow.id, {
						type: 'workflow.state',
						data: dataObj,
						sourceEventId: eventId ? `dapr-wf-state:${instanceId}:${eventId}` : null
					});
				}
			}
		} catch (err) {
			console.warn('[system-events] workflow-state bridge failed:', err);
		}
	}

	// Always return SUCCESS to acknowledge the message
	return json({ status: 'SUCCESS' });
};
