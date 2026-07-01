import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getEventBusAdapter } from '$lib/server/application/event-bus';

/**
 * HTTP ingest for trigger backings that can't publish to Dapr pub/sub directly —
 * notably an Argo Events Sensor HTTP trigger. Internal-token gated. It simply
 * republishes the (already-mapped) payload to the `workflow.triggers` topic, so
 * EVERY trigger source converges on the one pub/sub spine (idempotency + the
 * concurrency gate live there). Keeps Argo out of the start logic.
 *
 * Body: { workflowId|workflowName, triggerData?, dedupKey, triggerId? } — the
 * Argo Sensor maps event fields into this shape via its `payload` parameters.
 */
export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}
	const body = await request.json().catch(() => ({}));
	try {
		await getEventBusAdapter().publish('workflow.triggers', body);
		return json({ success: true }, { status: 202 });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'publish failed' },
			{ status: 502 }
		);
	}
};
