import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { workflowAgentEvents, workflowAgentRuns } from "@/lib/db/schema";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";

export type PersistedAgentEvent = AgentStreamEvent & {
	eventId: number;
	workflowExecutionId: string;
	workflowAgentRunId: string | null;
	parentExecutionId: string | null;
	daprInstanceId: string;
};

type AgentEventListener = (event: PersistedAgentEvent) => void;

const listeners = new Map<string, Set<AgentEventListener>>();

export function subscribeToAgentEvents(
	executionId: string,
	listener: AgentEventListener,
): () => void {
	const current = listeners.get(executionId) ?? new Set<AgentEventListener>();
	current.add(listener);
	listeners.set(executionId, current);
	return () => {
		const existing = listeners.get(executionId);
		if (!existing) {
			return;
		}
		existing.delete(listener);
		if (existing.size === 0) {
			listeners.delete(executionId);
		}
	};
}

function publishAgentEvents(
	executionId: string,
	events: PersistedAgentEvent[],
): void {
	const current = listeners.get(executionId);
	if (!current || current.size === 0) {
		return;
	}
	for (const event of events) {
		for (const listener of current) {
			listener(event);
		}
	}
}

export async function appendAgentEvents(input: {
	workflowExecutionId: string;
	parentExecutionId?: string | null;
	daprInstanceId: string;
	events: AgentStreamEvent[];
}): Promise<PersistedAgentEvent[]> {
	if (input.events.length === 0) {
		return [];
	}

	const [agentRun] = await db
		.select({ id: workflowAgentRuns.id })
		.from(workflowAgentRuns)
		.where(eq(workflowAgentRuns.daprInstanceId, input.daprInstanceId))
		.limit(1);

	const inserted = await db
		.insert(workflowAgentEvents)
		.values(
			input.events.map((event) => ({
				workflowExecutionId: input.workflowExecutionId,
				workflowAgentRunId: agentRun?.id ?? null,
				parentExecutionId: input.parentExecutionId ?? null,
				daprInstanceId: input.daprInstanceId,
				seq:
					typeof event.id === "string" && /^\d+$/.test(event.id)
						? Number.parseInt(event.id, 10)
						: null,
				eventType: event.type,
				phase: event.phase ?? null,
				toolName: event.toolName ?? null,
				sandboxName:
					typeof event.meta?.sandboxName === "string"
						? event.meta.sandboxName
						: null,
				traceId:
					typeof event.meta?.traceId === "string"
						? event.meta.traceId
						: typeof event.meta?.trace_id === "string"
							? event.meta.trace_id
							: null,
				payload: event as unknown as Record<string, unknown>,
				ts: new Date(event.ts),
			})),
		)
		.returning({
			eventId: workflowAgentEvents.eventId,
			workflowExecutionId: workflowAgentEvents.workflowExecutionId,
			workflowAgentRunId: workflowAgentEvents.workflowAgentRunId,
			parentExecutionId: workflowAgentEvents.parentExecutionId,
			daprInstanceId: workflowAgentEvents.daprInstanceId,
			payload: workflowAgentEvents.payload,
		});

	const persisted = inserted.map((row) => ({
		eventId: row.eventId,
		workflowExecutionId: row.workflowExecutionId,
		workflowAgentRunId: row.workflowAgentRunId,
		parentExecutionId: row.parentExecutionId,
		daprInstanceId: row.daprInstanceId,
		...(row.payload as unknown as AgentStreamEvent),
	}));

	publishAgentEvents(input.workflowExecutionId, persisted);
	return persisted;
}

export async function listAgentEvents(input: {
	workflowExecutionId: string;
	afterEventId?: number;
}): Promise<PersistedAgentEvent[]> {
	const rows = await db
		.select({
			eventId: workflowAgentEvents.eventId,
			workflowExecutionId: workflowAgentEvents.workflowExecutionId,
			workflowAgentRunId: workflowAgentEvents.workflowAgentRunId,
			parentExecutionId: workflowAgentEvents.parentExecutionId,
			daprInstanceId: workflowAgentEvents.daprInstanceId,
			payload: workflowAgentEvents.payload,
		})
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, input.workflowExecutionId),
				input.afterEventId != null
					? gt(workflowAgentEvents.eventId, input.afterEventId)
					: undefined,
			),
		)
		.orderBy(asc(workflowAgentEvents.eventId));

	return rows.map((row) => ({
		eventId: row.eventId,
		workflowExecutionId: row.workflowExecutionId,
		workflowAgentRunId: row.workflowAgentRunId,
		parentExecutionId: row.parentExecutionId,
		daprInstanceId: row.daprInstanceId,
		...(row.payload as unknown as AgentStreamEvent),
	}));
}

export async function listAgentEventsByInstances(input: {
	workflowExecutionId: string;
	daprInstanceIds: string[];
	afterEventId?: number;
}): Promise<PersistedAgentEvent[]> {
	if (input.daprInstanceIds.length === 0) {
		return [];
	}

	const rows = await db
		.select({
			eventId: workflowAgentEvents.eventId,
			workflowExecutionId: workflowAgentEvents.workflowExecutionId,
			workflowAgentRunId: workflowAgentEvents.workflowAgentRunId,
			parentExecutionId: workflowAgentEvents.parentExecutionId,
			daprInstanceId: workflowAgentEvents.daprInstanceId,
			payload: workflowAgentEvents.payload,
		})
		.from(workflowAgentEvents)
		.where(
			and(
				eq(workflowAgentEvents.workflowExecutionId, input.workflowExecutionId),
				inArray(workflowAgentEvents.daprInstanceId, input.daprInstanceIds),
				input.afterEventId != null
					? gt(workflowAgentEvents.eventId, input.afterEventId)
					: undefined,
			),
		)
		.orderBy(asc(workflowAgentEvents.eventId));

	return rows.map((row) => ({
		eventId: row.eventId,
		workflowExecutionId: row.workflowExecutionId,
		workflowAgentRunId: row.workflowAgentRunId,
		parentExecutionId: row.parentExecutionId,
		daprInstanceId: row.daprInstanceId,
		...(row.payload as unknown as AgentStreamEvent),
	}));
}
