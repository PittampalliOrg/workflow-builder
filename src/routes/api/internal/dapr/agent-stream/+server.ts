import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflowExecutions, workflowAgentRuns, workflowAgentEvents } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { getNatsConnection, executionSubject } from '$lib/server/nats-client';
import { daprEventStream } from '$lib/server/dapr-event-stream';

/**
 * Dapr pub/sub handler for agent execution events from workflow.stream.
 *
 * Receives events published by agent services (dapr-agent-py) via Dapr pub/sub.
 * Maps them to parent workflow executions, persists to DB (background),
 * and bridges to per-execution NATS subjects for SSE streaming.
 *
 * Returns SUCCESS immediately to avoid blocking Dapr ACK. DB persistence
 * is fire-and-forget with de-duplication via unique constraint.
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
		const sourceEventId = String(
			eventData.sourceEventId ??
			eventData.id ??
			body.id ??
			`${source}-${instanceId}-${eventType}-${timestamp}-${crypto.randomUUID().slice(0, 8)}`
		);

		// Skip non-agent events (sandbox events handled by sandbox-events handler)
		if (!source || source === 'openshell-agent-runtime') {
			return json({ status: 'SUCCESS' });
		}

		// Push to Dapr System dashboard event stream
		daprEventStream.push('workflow.stream', eventType, source, eventData);

		// Resolve the parent workflow execution ID (3-step lookup, no unsafe fallback)
		let parentExecutionId: string | null = null;

		if (db && (instanceId || executionId)) {
			// 1. Check agent runs table by daprInstanceId
			if (instanceId) {
				const [agentRun] = await db
					.select({ workflowExecutionId: workflowAgentRuns.workflowExecutionId })
					.from(workflowAgentRuns)
					.where(eq(workflowAgentRuns.daprInstanceId, instanceId))
					.limit(1);
				if (agentRun) {
					parentExecutionId = agentRun.workflowExecutionId;
				}
			}

			// 2. Check if instanceId IS a workflow execution's daprInstanceId
			if (!parentExecutionId && instanceId) {
				const [exec] = await db
					.select({ id: workflowExecutions.id })
					.from(workflowExecutions)
					.where(eq(workflowExecutions.daprInstanceId, instanceId))
					.limit(1);
				if (exec) {
					parentExecutionId = exec.id;
				}
			}

			// 3. Check if executionId from event payload is a valid execution
			if (!parentExecutionId && executionId) {
				const [exec] = await db
					.select({ id: workflowExecutions.id })
					.from(workflowExecutions)
					.where(eq(workflowExecutions.id, executionId))
					.limit(1);
				if (exec) {
					parentExecutionId = exec.id;
				}
			}

			// No unsafe "last resort" fallback — if we can't resolve, we skip DB persistence
			// but still bridge to NATS using the executionId from the event payload
		}

		// Bridge to per-execution NATS subject for SSE consumers (non-blocking)
		const targetExecutionId = parentExecutionId || executionId || instanceId;
		if (targetExecutionId) {
			try {
				const nc = await getNatsConnection();
				const subject = executionSubject(targetExecutionId);
				nc.publish(
					subject,
					new TextEncoder().encode(
						JSON.stringify({
							source,
							type: eventType,
							executionId: targetExecutionId,
							instanceId,
							daprInstanceId: instanceId,
							sourceEventId,
							data: eventData.data ?? eventData,
							timestamp,
						})
					)
				);
			} catch {
				// NATS unavailable — events still persist to DB
			}
		}

		// Persist to DB (fire-and-forget — don't block Dapr ACK)
		if (db && parentExecutionId && eventType) {
			db.insert(workflowAgentEvents)
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
				.onConflictDoNothing()
				.catch(() => {
					// De-dup conflict or schema mismatch — ignore
				});
		}
	} catch {
		// Malformed event — acknowledge anyway to prevent redelivery
	}

	return json({ status: 'SUCCESS' });
};
