/**
 * Dapr Pub/Sub Publisher
 *
 * Forwards agent events to Dapr pub/sub (best-effort).
 * Handles inbound Dapr subscription events for workflow context.
 */

import { eventBus } from "./event-bus.js";
import type { AgentEvent, DaprEvent } from "./types.js";

const DAPR_HOST = process.env.DAPR_HOST ?? "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT ?? "3500";
const PUBSUB_NAME = process.env.PUBSUB_NAME ?? "pubsub";
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC ?? "workflow.stream";
const EVENT_STREAM_PUBLISH_ENABLED = ["1", "true", "yes", "on"].includes(
	(process.env.DURABLE_EVENT_STREAM_PUBLISH_ENABLED ?? "")
		.trim()
		.toLowerCase(),
);
const LEGACY_COMPLETION_EVENTS_ENABLED = ["1", "true", "yes", "on"].includes(
	(process.env.DURABLE_LEGACY_COMPLETION_EVENTS_ENABLED ?? "")
		.trim()
		.toLowerCase(),
);

const publishUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/publish/${PUBSUB_NAME}/${PUBSUB_TOPIC}`;
let eventStreamPublishingDisabledReason: string | null = null;

function isMissingWorkflowInstance(body: string): boolean {
	const normalized = body.toLowerCase();
	return (
		normalized.includes("no such instance exists") ||
		normalized.includes("grpc_message:\\\"no such instance exists\\\"") ||
		normalized.includes('details = "no such instance exists"')
	);
}

async function publishEvent(event: AgentEvent): Promise<void> {
	if (!EVENT_STREAM_PUBLISH_ENABLED || eventStreamPublishingDisabledReason) {
		return;
	}

	try {
		const resp = await fetch(publishUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "durable-agent",
				type: event.type,
				runId: event.runId,
				callId: event.callId,
				data: event.data,
				timestamp: event.timestamp,
			}),
		});
		if (!resp.ok) {
			const status = resp.status;
			const body = await resp.text().catch(() => "");
			if (status === 404 || status === 400 || status === 403) {
				eventStreamPublishingDisabledReason = `HTTP ${status}`;
				console.info(
					`[dapr] Disabling best-effort event stream publishing for ${PUBSUB_NAME}/${PUBSUB_TOPIC}: ${eventStreamPublishingDisabledReason}`,
				);
				return;
			}
			console.warn(`[dapr] Publish failed: ${status}${body ? ` ${body}` : ""}`);
		}
	} catch (error) {
		eventStreamPublishingDisabledReason =
			error instanceof Error ? error.message : String(error);
		console.info(
			`[dapr] Disabling best-effort event stream publishing for ${PUBSUB_NAME}/${PUBSUB_TOPIC}: ${eventStreamPublishingDisabledReason}`,
		);
	}
}

/**
 * Publish an agent_completed event by directly raising an external event
 * on the orchestrator's parent workflow via Dapr service invocation.
 *
 * This bypasses pub/sub (which requires matching component scoping) and
 * instead calls the orchestrator's raise_event API directly.
 */
export async function publishCompletionEvent(opts: {
	agentWorkflowId: string;
	parentExecutionId: string;
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}): Promise<boolean> {
	if (!LEGACY_COMPLETION_EVENTS_ENABLED) {
		return false;
	}
	if (!opts.parentExecutionId) {
		console.warn("[dapr] No parentExecutionId, skipping completion event");
		return false;
	}

	const orchestratorAppId =
		process.env.ORCHESTRATOR_APP_ID ?? "workflow-orchestrator";
	const eventName = `agent_completed_${opts.agentWorkflowId}`;
	const eventData = {
		workflow_id: opts.agentWorkflowId,
		phase: "agent",
		success: opts.success,
		result: opts.result ?? {},
		error: opts.error,
		timestamp: new Date().toISOString(),
	};

	// Raise external event on the orchestrator's parent workflow via Dapr service invocation
	const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/invoke/${orchestratorAppId}/method/api/v2/workflows/${opts.parentExecutionId}/events`;

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				eventName,
				eventData,
			}),
		});
		if (!resp.ok) {
			const body = await resp.text();
			if (resp.status >= 500 && isMissingWorkflowInstance(body)) {
				console.info(
					`[dapr] Parent workflow ${opts.parentExecutionId} no longer exists; treating completion event "${eventName}" as terminal`,
				);
				return true;
			}
			console.warn(`[dapr] Raise event failed: ${resp.status} ${body}`);
			return false;
		} else {
			console.log(
				`[dapr] Raised external event "${eventName}" on parent ${opts.parentExecutionId} (success=${opts.success})`,
			);
			return true;
		}
	} catch (err) {
		console.error(`[dapr] Failed to raise completion event: ${err}`);
		return false;
	}
}

export function startDaprPublisher(): void {
	if (!EVENT_STREAM_PUBLISH_ENABLED) {
		console.log(
			`[durable-agent] Dapr publisher disabled for ${PUBSUB_NAME}/${PUBSUB_TOPIC}`,
		);
		return;
	}
	eventBus.on("event", (event: AgentEvent) => {
		publishEvent(event);
	});
	console.log(
		`[durable-agent] Dapr publisher started (${PUBSUB_NAME}/${PUBSUB_TOPIC})`,
	);
}

export function handleDaprSubscriptionEvent(daprEvent: DaprEvent): void {
	const ctx = eventBus.getWorkflowContext();
	eventBus.setWorkflowContext({
		receivedEvents: ctx.receivedEvents + 1,
		workflowId: (daprEvent.data?.workflowId as string) ?? ctx.workflowId,
		nodeId: (daprEvent.data?.nodeId as string) ?? ctx.nodeId,
		stepIndex: (daprEvent.data?.stepIndex as number) ?? ctx.stepIndex,
	});

	eventBus.emitEvent("dapr_event", {
		daprType: daprEvent.type,
		source: daprEvent.source,
		data: daprEvent.data,
	});
}

export function getDaprSubscriptions(): Array<{
	pubsubname: string;
	topic: string;
	route: string;
}> {
	return [
		{
			pubsubname: PUBSUB_NAME,
			topic: PUBSUB_TOPIC,
			route: "/api/dapr/sub",
		},
	];
}
