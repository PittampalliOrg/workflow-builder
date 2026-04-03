import { createHash } from 'node:crypto';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	workflowAgentEvents,
	workflowAgentRuns,
	type WorkflowAgentEventType
} from '$lib/server/db/schema';
import { validateInternalToken } from '$lib/server/internal-auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgentStreamEvent = {
	id?: string;
	type: string;
	phase?: string;
	toolName?: string;
	ts: string;
	meta?: Record<string, unknown>;
	[key: string]: unknown;
};

type AgentEventsIngestBody = {
	workflowExecutionId?: string;
	parentExecutionId?: string | null;
	daprInstanceId?: string;
	events?: AgentStreamEvent[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sourceEventIdForEvent(event: AgentStreamEvent, index: number): string {
	const explicitId = typeof event.id === 'string' ? event.id.trim() : '';
	if (explicitId) return explicitId;

	return createHash('sha256')
		.update(JSON.stringify({ index, event }))
		.digest('hex');
}

// ---------------------------------------------------------------------------
// POST /api/internal/agent-events
//
// Called by dapr-swe (and other internal services) to post agent event data
// for a workflow execution. Events are de-duplicated by (executionId,
// daprInstanceId, sourceEventId) unique constraint.
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
//
// Body:
//   {
//     workflowExecutionId: string,
//     parentExecutionId?: string | null,
//     daprInstanceId?: string,
//     events: AgentStreamEvent[]
//   }
//
// Returns:
//   { success: true, count: number, lastEventId: number | null }
// ---------------------------------------------------------------------------

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	if (!db) {
		return json({ error: 'Database not configured' }, { status: 503 });
	}

	let body: AgentEventsIngestBody;
	try {
		body = (await request.json()) as AgentEventsIngestBody;
	} catch {
		return json({ error: 'Invalid JSON' }, { status: 400 });
	}

	const workflowExecutionId = body.workflowExecutionId?.trim();
	const daprInstanceId = body.daprInstanceId?.trim();
	const events = Array.isArray(body.events) ? body.events : [];

	if (!workflowExecutionId || !daprInstanceId) {
		return json(
			{ error: 'workflowExecutionId and daprInstanceId are required' },
			{ status: 400 }
		);
	}

	if (events.length === 0) {
		return json({ success: true, count: 0, lastEventId: null });
	}

	// Look up the agent run by daprInstanceId (if one exists)
	const [agentRun] = await db
		.select({ id: workflowAgentRuns.id })
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.daprInstanceId, daprInstanceId))
		.limit(1);

	// Prepare events for insert
	const preparedEvents = events.map((event, index) => ({
		event,
		sourceEventId: sourceEventIdForEvent(event, index)
	}));

	const inserted = await db
		.insert(workflowAgentEvents)
		.values(
			preparedEvents.map(({ event, sourceEventId }) => ({
				workflowExecutionId,
				workflowAgentRunId: agentRun?.id ?? null,
				parentExecutionId: body.parentExecutionId ?? null,
				daprInstanceId,
				sourceEventId,
				seq:
					typeof event.id === 'string' && /^\d+$/.test(event.id)
						? parseInt(event.id, 10)
						: null,
				eventType: (event.type ?? (event as Record<string, unknown>).event_type ?? 'unknown') as WorkflowAgentEventType,
				phase: event.phase ?? null,
				toolName: event.toolName ?? null,
				sandboxName:
					typeof event.meta?.sandboxName === 'string' ? event.meta.sandboxName : null,
				traceId:
					typeof event.meta?.traceId === 'string'
						? event.meta.traceId
						: typeof event.meta?.trace_id === 'string'
							? event.meta.trace_id
							: null,
				payload: event as unknown as Record<string, unknown>,
				ts: event.ts ? new Date(event.ts) : new Date()
			}))
		)
		.onConflictDoNothing({
			target: [
				workflowAgentEvents.workflowExecutionId,
				workflowAgentEvents.daprInstanceId,
				workflowAgentEvents.sourceEventId
			]
		})
		.returning({
			eventId: workflowAgentEvents.eventId,
			workflowExecutionId: workflowAgentEvents.workflowExecutionId,
			workflowAgentRunId: workflowAgentEvents.workflowAgentRunId,
			parentExecutionId: workflowAgentEvents.parentExecutionId,
			daprInstanceId: workflowAgentEvents.daprInstanceId
		});

	if (inserted.length > 0) {
		console.info(
			`[agent-events] persisted count=${inserted.length} execution=${workflowExecutionId} instance=${daprInstanceId} range=${inserted[0]?.eventId ?? 'n/a'}-${inserted.at(-1)?.eventId ?? 'n/a'}`
		);
	} else {
		console.info(
			`[agent-events] persisted count=0 deduped=${events.length} execution=${workflowExecutionId} instance=${daprInstanceId} submitted=${events.length}`
		);
	}

	return json({
		success: true,
		count: inserted.length,
		lastEventId: inserted.at(-1)?.eventId ?? null
	});
};
