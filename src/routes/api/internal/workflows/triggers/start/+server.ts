import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { startWorkflowRun } from '$lib/server/workflows/start-run';
import { triggerExecutionId } from '$lib/server/workflows/trigger-id';

/**
 * The event-driven workflow-START spine.
 *
 * Every trigger backing (Dapr schedule job, declarative Subscription, input
 * binding, or an Argo Events Sensor) funnels here by publishing a CloudEvent to
 * the `workflow.triggers` Dapr topic (declarative Subscription routes it to this
 * route). We resolve the target workflow + start it via the canonical
 * `startWorkflowRun()` with a deterministic execution id derived from `dedupKey`,
 * so at-least-once redelivery is effectively-once.
 *
 * Dapr pub/sub contract: ALWAYS ACK ({status:"SUCCESS"}) so a poison message
 * can't wedge the subscription (JetStream max-deliver → DLQ governs).
 */

type TriggerPayload = {
	workflowId?: string;
	workflowName?: string;
	triggerData?: Record<string, unknown>;
	dedupKey?: string;
};

// Dapr pub/sub ACK ("SUCCESS" drops the message; we always drop — never wedge).
const ACK = () => json({ status: 'SUCCESS' });

export const POST: RequestHandler = async ({ request }) => {
	let body: Record<string, unknown> = {};
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		return ACK();
	}

	// CloudEvent envelope (`data`) or a bare body; `id` is the dedup fallback.
	const data = (
		typeof body.data === 'object' && body.data !== null ? body.data : body
	) as TriggerPayload;
	const cloudEventId = typeof body.id === 'string' ? body.id : undefined;

	const dedupKey =
		(typeof data.dedupKey === 'string' && data.dedupKey.trim()) || cloudEventId || '';
	const workflowId = typeof data.workflowId === 'string' ? data.workflowId.trim() : undefined;
	const workflowName = typeof data.workflowName === 'string' ? data.workflowName.trim() : undefined;

	if (!dedupKey || (!workflowId && !workflowName)) {
		console.warn('[workflow-triggers/start] missing dedupKey or workflow ref; dropping', {
			hasDedup: !!dedupKey,
			workflowId,
			workflowName
		});
		return ACK();
	}

	const triggerData =
		typeof data.triggerData === 'object' && data.triggerData !== null
			? (data.triggerData as Record<string, unknown>)
			: {};
	// Carry the event id so the run records what fired it.
	if (cloudEventId && triggerData.eventId === undefined) triggerData.eventId = cloudEventId;

	try {
		const result = await startWorkflowRun({
			workflowId,
			workflowName,
			triggerData,
			executionId: triggerExecutionId(dedupKey),
			idempotent: true
		});
		if (!result.ok) {
			// 4xx (e.g. workflow not found / invalid spec) is a permanent failure for
			// THIS message — ACK so it doesn't redeliver forever. 5xx is transient,
			// but we still ACK and rely on the source to re-fire (events are signals).
			console.warn('[workflow-triggers/start] start failed; dropping message', {
				status: result.status,
				error: result.error,
				workflowId,
				workflowName
			});
		} else {
			console.info('[workflow-triggers/start] started', {
				executionId: result.executionId,
				reused: result.reused,
				workflowId: result.workflowId
			});
		}
	} catch (err) {
		console.error('[workflow-triggers/start] unexpected error; ACK to avoid wedge', err);
	}
	return ACK();
};
