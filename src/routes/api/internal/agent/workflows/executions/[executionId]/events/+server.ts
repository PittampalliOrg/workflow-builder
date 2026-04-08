import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { db } from '$lib/server/db';
import { assertExecutionReadModelColumns } from '$lib/server/db/execution-read-model-support';
import {
	workflowExecutions,
	workflowAgentEvents,
	workflowAgentRuns,
	type WorkflowAgentEventType
} from '$lib/server/db/schema';
import { and, eq, max } from 'drizzle-orm';

type IncomingAgentEvent = {
	id?: string;
	ts?: string;
	type?: string;
	agentRunId?: string | null;
	runId?: string | null;
	phase?: string | null;
	toolName?: string | null;
	sandboxName?: string | null;
	traceId?: string | null;
	payload?: Record<string, unknown>;
	[key: string]: unknown;
};

const ALLOWED_EVENT_TYPES = new Set<WorkflowAgentEventType>([
	'run_started',
	'model_start',
	'model_complete',
	'tool_start',
	'tool_complete',
	'tool_error',
	'sandbox_output',
	'sandbox_output_partial',
	'sandbox_heartbeat',
	'run_complete',
	'run_error'
]);

function normalizeTimestamp(value: string | undefined): Date {
	if (typeof value === 'string' && value.trim()) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) {
			return parsed;
		}
	}
	return new Date();
}

function normalizeIncomingEvent(
	event: IncomingAgentEvent,
	workflowExecutionId: string,
	input: {
		workflowAgentRunId: string | null;
		parentExecutionId: string | null;
		daprInstanceId: string;
		seqStart: number;
		index: number;
	}
) {
	const payloadId = String(event.id ?? '').trim();
	const eventType = String(event.type ?? '').trim() as WorkflowAgentEventType;
	if (!payloadId || !ALLOWED_EVENT_TYPES.has(eventType)) {
		return null;
	}

	const payload = {
		...event,
		id: payloadId,
		type: eventType,
		ts: typeof event.ts === 'string' && event.ts.trim() ? event.ts : new Date().toISOString()
	};

	return {
		workflowExecutionId,
		workflowAgentRunId: input.workflowAgentRunId,
		parentExecutionId: input.parentExecutionId,
		daprInstanceId: input.daprInstanceId,
		sourceEventId: payloadId,
		seq: input.seqStart + input.index + 1,
		eventType,
		phase: typeof event.phase === 'string' ? event.phase : null,
		toolName: typeof event.toolName === 'string' ? event.toolName : null,
		sandboxName: typeof event.sandboxName === 'string' ? event.sandboxName : null,
		traceId: typeof event.traceId === 'string' ? event.traceId : null,
		ts: normalizeTimestamp(payload.ts),
		payload: payload as Record<string, unknown>
	};
}

/**
 * POST /api/internal/agent/workflows/executions/[executionId]/events
 *
 * Stores agent execution events from backend services (durable-agent).
 * Security: Validated via X-Internal-Token header.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	if (!db) {
		return error(503, 'Database not configured');
	}
	try {
		await assertExecutionReadModelColumns();
	} catch (schemaError) {
		console.error(
			'[agent/workflows/executions/events] execution read-model schema check failed:',
			schemaError
		);
		return error(
			503,
			schemaError instanceof Error
				? schemaError.message
				: 'Execution read-model migration is required'
		);
	}

	const { executionId } = params;

	const [execution] = await db
		.select({
			id: workflowExecutions.id,
			phase: workflowExecutions.phase,
			primaryTraceId: workflowExecutions.primaryTraceId
		})
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, executionId))
		.limit(1);

	if (!execution) {
		return error(404, 'Execution not found');
	}

	const body = (await request.json().catch(() => ({}))) as {
		agentRunId?: string | null;
		daprInstanceId?: string | null;
		parentExecutionId?: string | null;
		events?: IncomingAgentEvent[];
	};
	const events = Array.isArray(body.events) ? body.events : [];
	const daprInstanceId = String(
		body.daprInstanceId ??
			body.agentRunId ??
			events.find((e) => typeof e.runId === 'string')?.runId ??
			''
	).trim();

	if (!daprInstanceId) {
		return json({ error: 'Missing daprInstanceId for agent events' }, { status: 400 });
	}

	// Look up the agent run record for this execution + instance
	const [agentRun] = await db
		.select({ id: workflowAgentRuns.id, parentExecutionId: workflowAgentRuns.parentExecutionId })
		.from(workflowAgentRuns)
		.where(
			and(
				eq(workflowAgentRuns.workflowExecutionId, executionId),
				eq(workflowAgentRuns.daprInstanceId, daprInstanceId)
			)
		)
		.limit(1);

	// Get the current max sequence number for this execution + instance
	const [seqRow] = await db
		.select({ maxSeq: max(workflowAgentEvents.seq) })
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, executionId),
				eq(workflowAgentEvents.daprInstanceId, daprInstanceId)
			)
		);
	const seqStart = Number(seqRow?.maxSeq ?? 0);

	const normalized = events
		.map((event, index) =>
			normalizeIncomingEvent(event, executionId, {
				workflowAgentRunId: agentRun?.id ?? null,
				parentExecutionId:
					agentRun?.parentExecutionId ?? body.parentExecutionId ?? null,
				daprInstanceId,
				seqStart,
				index
			})
		)
		.filter((event): event is NonNullable<typeof event> => Boolean(event));

	if (normalized.length === 0) {
		return json({ error: 'No valid agent events provided' }, { status: 400 });
	}

	// Persist events with conflict-safe upsert (idempotent)
	const inserted = await db
		.insert(workflowAgentEvents)
		.values(normalized)
		.onConflictDoNothing({
			target: [
				workflowAgentEvents.workflowExecutionId,
				workflowAgentEvents.daprInstanceId,
				workflowAgentEvents.sourceEventId
			]
		})
		.returning({
			eventId: workflowAgentEvents.eventId,
			traceId: workflowAgentEvents.traceId,
			phase: workflowAgentEvents.phase
		});

	const latestInserted = inserted.at(-1);
	if (latestInserted) {
		const nextTraceId =
			inserted
				.map((row) => row.traceId)
				.reverse()
				.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
			execution.primaryTraceId;
		const nextPhase =
			inserted
				.map((row) => row.phase)
				.reverse()
				.find((value): value is string => typeof value === 'string' && value.trim().length > 0) ??
			execution.phase;

		await db
			.update(workflowExecutions)
			.set({
				lastAgentEventId: latestInserted.eventId,
				primaryTraceId: nextTraceId ?? undefined,
				phase: nextPhase ?? undefined
			})
			.where(eq(workflowExecutions.id, executionId));
	}

	return json({
		success: true,
		executionId,
		persisted: inserted.length
	});
};
