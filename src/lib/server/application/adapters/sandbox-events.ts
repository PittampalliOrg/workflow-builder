import { and, asc, eq, gt } from "drizzle-orm";
import type { SandboxAgentEventReadPort } from "$lib/server/application/ports";
import { db } from "$lib/server/db";
import { sessionEvents, sessions } from "$lib/server/db/schema";
import type { ExecutionTimelineEvent } from "$lib/types/execution-stream";

type SandboxSessionEventRow = {
	sequence: number;
	sessionId: string;
	type: string;
	data: unknown;
	sourceEventId: string | null;
	createdAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapSessionAgentEvent(row: SandboxSessionEventRow): ExecutionTimelineEvent {
	const data = isRecord(row.data) ? { ...row.data } : {};
	const toolName =
		typeof data.tool_name === "string"
			? data.tool_name
			: typeof data.toolName === "string"
				? data.toolName
				: typeof data.name === "string"
					? data.name
					: null;
	const phase = typeof data.phase === "string" ? data.phase : null;
	return {
		id: row.sequence,
		type: row.type,
		data,
		timestamp: row.createdAt.toISOString(),
		workflowAgentRunId: row.sessionId,
		daprInstanceId: row.sessionId,
		sourceEventId: row.sourceEventId,
		phase,
		toolName,
	};
}

export class PostgresSandboxAgentEventReadPort implements SandboxAgentEventReadPort {
	async listSandboxAgentEvents(input: {
		sandboxName: string;
		afterEventId?: number;
		limit?: number;
	}): Promise<ExecutionTimelineEvent[]> {
		if (!db) return [];
		const rows = await db
			.select({
				sequence: sessionEvents.sequence,
				sessionId: sessionEvents.sessionId,
				type: sessionEvents.type,
				data: sessionEvents.data,
				sourceEventId: sessionEvents.sourceEventId,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
			.where(
				and(
					eq(sessions.sandboxName, input.sandboxName),
					gt(sessionEvents.sequence, input.afterEventId ?? 0),
				),
			)
			.orderBy(asc(sessionEvents.sequence))
			.limit(input.limit ?? 200);
		return rows.map((row) => mapSessionAgentEvent(row));
	}
}
