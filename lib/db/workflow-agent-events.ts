import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import {
	type NewWorkflowAgentEvent,
	type WorkflowAgentEvent,
	workflowAgentEvents,
} from "@/lib/db/schema";

export type PersistWorkflowAgentEventInput = {
	workflowExecutionId: string;
	workflowAgentRunId?: string | null;
	parentExecutionId?: string | null;
	daprInstanceId: string;
	sourceEventId: string;
	seq?: number | null;
	eventType: NewWorkflowAgentEvent["eventType"];
	phase?: string | null;
	toolName?: string | null;
	sandboxName?: string | null;
	traceId?: string | null;
	ts: Date | string;
	payload: Record<string, unknown>;
};

function normalizeTimestamp(value: Date | string): Date {
	if (value instanceof Date) {
		return value;
	}

	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return new Date();
	}

	return parsed;
}

export async function persistWorkflowAgentEvents(
	events: PersistWorkflowAgentEventInput[],
) {
	if (events.length === 0) {
		return [];
	}

	const values = events.map((event) => ({
		workflowExecutionId: event.workflowExecutionId,
		workflowAgentRunId: event.workflowAgentRunId ?? null,
		parentExecutionId: event.parentExecutionId ?? null,
		daprInstanceId: event.daprInstanceId,
		sourceEventId: event.sourceEventId,
		seq: event.seq ?? null,
		eventType: event.eventType,
		phase: event.phase ?? null,
		toolName: event.toolName ?? null,
		sandboxName: event.sandboxName ?? null,
		traceId: event.traceId ?? null,
		ts: normalizeTimestamp(event.ts),
		payload: event.payload,
	}));

	await db
		.insert(workflowAgentEvents)
		.values(values)
		.onConflictDoNothing({
			target: [
				workflowAgentEvents.workflowExecutionId,
				workflowAgentEvents.daprInstanceId,
				workflowAgentEvents.sourceEventId,
			],
		});

	return listWorkflowAgentEvents(values[0].workflowExecutionId);
}

export async function listWorkflowAgentEvents(workflowExecutionId: string) {
	return db
		.select()
		.from(workflowAgentEvents)
		.where(eq(workflowAgentEvents.workflowExecutionId, workflowExecutionId))
		.orderBy(asc(workflowAgentEvents.eventId));
}

export async function listWorkflowAgentEventsAfterId(input: {
	workflowExecutionId: string;
	lastEventId: string | null;
}) {
	const lastEventId = Number.parseInt(input.lastEventId ?? "", 10);
	if (!Number.isFinite(lastEventId)) {
		return listWorkflowAgentEvents(input.workflowExecutionId);
	}
	return db
		.select()
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, input.workflowExecutionId),
				gt(workflowAgentEvents.eventId, lastEventId),
			),
		)
		.orderBy(asc(workflowAgentEvents.eventId))
		.then((events) => events as WorkflowAgentEvent[]);
}

export async function findWorkflowAgentEventByPayloadId(input: {
	workflowExecutionId: string;
	payloadId: string;
}) {
	const matches = await db
		.select()
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, input.workflowExecutionId),
				eq(workflowAgentEvents.sourceEventId, input.payloadId),
			),
		)
		.limit(1);
	return matches[0] ?? null;
}
