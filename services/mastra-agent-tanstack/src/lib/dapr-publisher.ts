/**
 * Dapr Pub/Sub Publisher
 *
 * Forwards agent events to Dapr pub/sub (best-effort).
 * Handles inbound Dapr subscription events for workflow context.
 */

import { eventBus } from "./event-bus";
import type { AgentEvent, DaprEvent } from "./types";

const DAPR_HOST = process.env.DAPR_HOST ?? "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT ?? "3500";
const PUBSUB_NAME = process.env.PUBSUB_NAME ?? "pubsub";
const PUBSUB_TOPIC = process.env.PUBSUB_TOPIC ?? "workflow.stream";

const publishUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/publish/${PUBSUB_NAME}/${PUBSUB_TOPIC}`;

async function publishEvent(event: AgentEvent): Promise<void> {
	try {
		const resp = await fetch(publishUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "mastra-agent-tanstack",
				type: event.type,
				runId: event.runId,
				callId: event.callId,
				data: event.data,
				timestamp: event.timestamp,
			}),
		});
		if (!resp.ok) {
			console.warn(`[dapr] Publish failed: ${resp.status}`);
		}
	} catch {
		// Silent fail — Dapr sidecar may not be present in local dev
	}
}

/**
 * Publish an agent_completed event in the format the orchestrator's
 * subscription handler (agent_events) expects.
 *
 * The handler extracts:
 *   event_data.get("type")          → "agent_completed"
 *   event_data.get("workflowId")    → maps to external event name
 *   inner_data.get("parent_execution_id") → routes to parent workflow
 *   inner_data.get("success"), inner_data.get("result") → forwarded as payload
 */
export async function publishCompletionEvent(opts: {
	agentWorkflowId: string;
	parentExecutionId: string;
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}): Promise<void> {
	try {
		const resp = await fetch(publishUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				source: "mastra-agent-tanstack",
				type: "agent_completed",
				workflowId: opts.agentWorkflowId,
				data: {
					parent_execution_id: opts.parentExecutionId,
					success: opts.success,
					result: opts.result ?? {},
					error: opts.error,
				},
				timestamp: new Date().toISOString(),
			}),
		});
		if (!resp.ok) {
			console.warn(`[dapr] Publish completion failed: ${resp.status}`);
		} else {
			console.log(
				`[dapr] Published agent_completed for ${opts.agentWorkflowId} (success=${opts.success})`,
			);
		}
	} catch (err) {
		console.error(`[dapr] Failed to publish completion event: ${err}`);
	}
}

export function startDaprPublisher(): void {
	eventBus.on("event", (event: AgentEvent) => {
		publishEvent(event);
	});
	console.log(
		`[mastra-tanstack] Dapr publisher started (${PUBSUB_NAME}/${PUBSUB_TOPIC})`,
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
