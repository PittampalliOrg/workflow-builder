import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflowAgentRuns, workflowAgentEvents } from '$lib/server/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { getNatsConnection, executionSubject } from '$lib/server/nats-client';
import { daprEventStream } from '$lib/server/dapr-event-stream';

/**
 * Dapr pub/sub handler for agent execution events from workflow.stream.
 *
 * Receives events published by agent services (dapr-agent-py, durable-agent)
 * via Dapr pub/sub. Maps them to parent workflow executions, persists to DB,
 * and bridges to per-execution NATS subjects for SSE streaming.
 */
export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();

		// Extract CloudEvents envelope
		const eventData = body.data ?? body;
		const source = eventData.source ?? body.source ?? '';
		const eventType = eventData.type ?? '';
		const instanceId = eventData.instanceId ?? '';
		const executionId = eventData.executionId ?? '';
		const timestamp = eventData.timestamp ?? new Date().toISOString();

		// Skip non-agent events (sandbox events are handled by sandbox-events handler)
		if (!source || source === 'openshell-agent-runtime') {
			return json({ status: 'SUCCESS' });
		}

		// Push to the Dapr System dashboard event stream
		daprEventStream.push('workflow.stream', eventType, source, eventData);

		// Try to find the parent workflow execution
		let parentExecutionId: string | null = null;

		if (db && instanceId) {
			// Check if this instanceId matches an agent run's daprInstanceId
			const [agentRun] = await db
				.select({
					workflowExecutionId: workflowAgentRuns.workflowExecutionId,
					id: workflowAgentRuns.id,
				})
				.from(workflowAgentRuns)
				.where(eq(workflowAgentRuns.daprInstanceId, instanceId))
				.limit(1);

			if (agentRun) {
				parentExecutionId = agentRun.workflowExecutionId;
			} else {
				// Try matching by execution ID directly
				const [exec] = await db
					.select({ id: workflowExecutions.id })
					.from(workflowExecutions)
					.where(eq(workflowExecutions.daprInstanceId, instanceId))
					.limit(1);

				if (exec) {
					parentExecutionId = exec.id;
				}
			}
		}

		// Bridge to per-execution NATS subject for SSE consumers
		const targetExecutionId = parentExecutionId || executionId || instanceId;
		if (targetExecutionId) {
			try {
				const nc = await getNatsConnection();
				const subject = executionSubject(targetExecutionId);
				const encoder = new TextEncoder();
				nc.publish(
					subject,
					encoder.encode(
						JSON.stringify({
							source,
							type: eventType,
							executionId: targetExecutionId,
							instanceId,
							data: eventData.data ?? eventData,
							timestamp,
						})
					)
				);
			} catch {
				// NATS unavailable — events still flow through DB polling
			}
		}

		// Persist agent events to DB if we found the parent execution
		if (db && parentExecutionId && eventType) {
			const sourceEventId = `${source}-${instanceId}-${eventType}-${timestamp}`;

			try {
				await db
					.insert(workflowAgentEvents)
					.values({
						workflowExecutionId: parentExecutionId,
						daprInstanceId: instanceId,
						sourceEventId,
						eventType: eventType as any,
						phase: eventData.data?.phase ?? null,
						toolName: eventData.data?.toolName ?? null,
						sandboxName: eventData.data?.sandboxName ?? null,
						payload: eventData.data ?? eventData,
						ts: new Date(timestamp),
					})
					.onConflictDoNothing();
			} catch {
				// De-dup conflict or schema mismatch — ignore
			}
		}
	} catch {
		// Malformed event — acknowledge anyway to prevent redelivery
	}

	return json({ status: 'SUCCESS' });
};
