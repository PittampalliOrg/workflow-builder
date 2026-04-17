import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	workflowExecutions,
	workflowAgentRuns,
	workflowAgentEvents,
	type WorkflowAgentEventType
} from '$lib/server/db/schema';
import { and, eq, max } from 'drizzle-orm';
import { getNatsConnection, executionSubject } from '$lib/server/nats-client';
import { daprEventStream } from '$lib/server/dapr-event-stream';
import { persistCodeCheckpointFromAgentEvent } from '$lib/server/workflows/code-checkpoints';
import { appendEvent as appendSessionEvent } from '$lib/server/sessions/events';

const ALLOWED_EVENT_TYPES = new Set<WorkflowAgentEventType>([
	'run_started',
	'turn_started',
	'llm_start',
	'llm_token',
	'llm_complete',
	'tool_call_start',
	'tool_call_end',
	'tool_call_error',
	'sandbox_output',
	'sandbox_output_partial',
	'sandbox_heartbeat',
	'state_snapshot',
	'run_complete',
	'run_error',
	'tool_start',
	'tool_complete',
	'tool_error',
	'model_start',
	'model_complete'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value: unknown): Date {
	if (typeof value === 'string' && value.trim()) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	return new Date();
}

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
		const sessionId: string =
			typeof eventData.sessionId === 'string' && eventData.sessionId.trim()
				? eventData.sessionId.trim()
				: '';
		const sessionType: string | null =
			typeof eventData.sessionType === 'string' ? eventData.sessionType : null;
		const sessionData: Record<string, unknown> | null = isRecord(eventData.sessionData)
			? (eventData.sessionData as Record<string, unknown>)
			: null;
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
		let workflowAgentRunId: string | null = null;
		let agentRunParentExecutionId: string | null = null;

		if (db && (instanceId || executionId)) {
			// 1. Check agent runs table by daprInstanceId
			if (instanceId) {
				const [agentRun] = await db
					.select({
						id: workflowAgentRuns.id,
						workflowExecutionId: workflowAgentRuns.workflowExecutionId,
						parentExecutionId: workflowAgentRuns.parentExecutionId
					})
					.from(workflowAgentRuns)
					.where(eq(workflowAgentRuns.daprInstanceId, instanceId))
					.limit(1);
				if (agentRun) {
					parentExecutionId = agentRun.workflowExecutionId;
					workflowAgentRunId = agentRun.id;
					agentRunParentExecutionId = agentRun.parentExecutionId;
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

		const eventPayload = isRecord(eventData.data)
			? {
					...eventData.data,
					id: sourceEventId,
					type: eventType,
					ts: timestamp,
					source,
					executionId: parentExecutionId || executionId || null,
					daprInstanceId: instanceId || null,
					workflowAgentRunId,
					parentExecutionId: agentRunParentExecutionId
				}
			: {
					id: sourceEventId,
					type: eventType,
					ts: timestamp,
					source,
					executionId: parentExecutionId || executionId || null,
					daprInstanceId: instanceId || null,
					workflowAgentRunId,
					parentExecutionId: agentRunParentExecutionId,
					value: eventData.data ?? null
				};
		const phase = stringValue(eventPayload.phase);
		const toolName = stringValue(eventPayload.toolName) ?? stringValue(eventPayload.name);
		const traceId = stringValue(eventPayload.traceId);
		const sandboxName =
			stringValue(eventPayload.sandboxName) ??
			(source.startsWith('dapr-agent-py') ? source : null);

		// Phase 4 unified event stream: when the event carries a sessionId and
		// the producer hasn't suppressed the session mapping (sessionType != null),
		// dual-write the CMA-shaped payload to session_events so /sessions/[id]
		// shows the full agent stream. Skip `session.*` types — those arrive via
		// the direct ingest path from publish_session_event and would duplicate.
		if (db && sessionId && sessionType && !sessionType.startsWith('session.')) {
			try {
				await appendSessionEvent(sessionId, {
					type: sessionType,
					data: sessionData ?? {},
					sourceEventId,
				});
			} catch (err) {
				console.warn('[agent-stream] session_events dual-write failed:', err);
			}
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
							workflowAgentRunId,
							instanceId,
							daprInstanceId: instanceId,
							sourceEventId,
							phase,
							toolName,
							data: eventPayload,
							timestamp,
						})
					)
				);
			} catch {
				// NATS unavailable — events still persist to DB
			}
		}

		// Persist to the execution read model. This is the canonical UI history;
		// NATS is only the live transport.
		if (db && parentExecutionId && eventType && ALLOWED_EVENT_TYPES.has(eventType as WorkflowAgentEventType)) {
			const [seqRow] = await db
				.select({ maxSeq: max(workflowAgentEvents.seq) })
				.from(workflowAgentEvents)
				.where(
					and(
						eq(workflowAgentEvents.workflowExecutionId, parentExecutionId),
						eq(workflowAgentEvents.daprInstanceId, instanceId || source)
					)
				);
			const seq = Number(seqRow?.maxSeq ?? 0) + 1;

			const inserted = await db
				.insert(workflowAgentEvents)
				.values({
					workflowExecutionId: parentExecutionId,
					workflowAgentRunId,
					parentExecutionId: agentRunParentExecutionId,
					daprInstanceId: instanceId || source,
					sourceEventId,
					eventType: eventType as any,
					seq,
					phase,
					toolName,
					sandboxName,
					traceId,
					payload: eventPayload,
					ts: normalizeTimestamp(timestamp),
				})
				.onConflictDoNothing()
				.returning({
					eventId: workflowAgentEvents.eventId,
					traceId: workflowAgentEvents.traceId,
					phase: workflowAgentEvents.phase
				});
			const latestInserted = inserted.at(-1);
			if (isRecord(eventPayload.codeCheckpoint)) {
				await persistCodeCheckpointFromAgentEvent({
					workflowExecutionId: parentExecutionId,
					workflowAgentRunId,
					workflowAgentEventId: latestInserted?.eventId ?? null,
					parentExecutionId: agentRunParentExecutionId,
					daprInstanceId: instanceId || source,
					sourceEventId,
					seq,
					toolName: toolName ?? eventType,
					nodeId: stringValue(eventPayload.nodeId),
					payload: eventPayload.codeCheckpoint
				});
			}
			if (latestInserted) {
				await db
					.update(workflowExecutions)
					.set({
						lastAgentEventId: latestInserted.eventId,
						primaryTraceId: latestInserted.traceId ?? undefined,
						phase: latestInserted.phase ?? undefined
					})
					.where(eq(workflowExecutions.id, parentExecutionId));
			}
		}
	} catch {
		// Malformed event — acknowledge anyway to prevent redelivery
	}

	return json({ status: 'SUCCESS' });
};
