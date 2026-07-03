import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * The event-driven workflow-START spine.
 *
 * Every trigger backing (Dapr schedule job, declarative Subscription, input
 * binding, or an Argo Events Sensor) funnels here by publishing a CloudEvent to
 * the `workflow.triggers` Dapr topic (declarative Subscription routes it to this
 * route). We resolve the target workflow + start it via the canonical
 * the application trigger-start service with a deterministic execution id derived
 * from `dedupKey`, so at-least-once redelivery is effectively-once.
 *
 * Dapr pub/sub contract: ALWAYS ACK ({status:"SUCCESS"}) so a poison message
 * can't wedge the subscription (JetStream max-deliver → DLQ governs).
 */

// Dapr pub/sub status responses:
//  - SUCCESS → drop (handled / permanent failure — never wedge).
//  - RETRY   → NACK; JetStream redelivers after ackWait (used to DEFER over the
//              concurrency cap, bounded by the component's maxDeliver → DLQ).
const daprStatus = (status: "SUCCESS" | "RETRY") => json({ status });

export const POST: RequestHandler = async ({ request }) => {
	let body: unknown = {};
	try {
		body = await request.json();
	} catch {
		return daprStatus("SUCCESS");
	}

	const result =
		await getApplicationAdapters().triggeredWorkflowStart.handleTriggerMessage(
			body,
		);
	return daprStatus(result.daprStatus);
};
