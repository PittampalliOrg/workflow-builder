import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { daprFetch, getDaprSidecarUrl } from '$lib/server/dapr-client';

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
		const res = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/publish/workflow-triggers-pubsub/workflow.triggers`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}
		);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return json({ error: `publish failed (${res.status})`, detail: text }, { status: 502 });
		}
		return json({ success: true }, { status: 202 });
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'publish failed' },
			{ status: 502 }
		);
	}
};
