import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessionEvents,
	type SessionEvent as SessionEventRow,
} from "$lib/server/db/schema";
import type {
	SessionEventEnvelope,
	UserEvent,
} from "$lib/types/sessions";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function rowToEnvelope(row: SessionEventRow): SessionEventEnvelope {
	return {
		id: row.id,
		sessionId: row.sessionId,
		sequence: row.sequence,
		type: row.type,
		data: (row.data as Record<string, unknown>) ?? {},
		processedAt: row.processedAt ? row.processedAt.toISOString() : null,
		sourceEventId: row.sourceEventId ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * Append an event to a session's log. Sequence is computed server-side via
 * a max+1 lookup inside the insert; concurrent inserts on the same session
 * serialize via the unique constraint on (session_id, sequence). This is
 * called both by the user-event send endpoint and by the workflow's event
 * emitter (via an internal endpoint in Phase 3.5).
 */
export async function appendEvent(
	sessionId: string,
	event: {
		type: string;
		data?: Record<string, unknown>;
		processedAt?: Date | null;
		sourceEventId?: string | null;
	},
): Promise<SessionEventEnvelope> {
	const database = requireDb();
	// Retry loop for sequence collisions under concurrent writers.
	for (let attempt = 0; attempt < 5; attempt++) {
		const [{ maxSeq }] = await database
			.select({
				maxSeq: sql<number>`coalesce(max(${sessionEvents.sequence}), 0)`,
			})
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, sessionId));
		const nextSeq = Number(maxSeq ?? 0) + 1;
		try {
			const [row] = await database
				.insert(sessionEvents)
				.values({
					sessionId,
					sequence: nextSeq,
					type: event.type,
					data: event.data ?? {},
					processedAt: event.processedAt ?? null,
					sourceEventId: event.sourceEventId ?? null,
				})
				.returning();
			return rowToEnvelope(row);
		} catch (err) {
			// Unique violation on sequence — someone else won the race. Retry.
			// Also: unique violation on (session_id, source_event_id) — same
			// event delivered twice (e.g. Dapr replay fires publish_event again,
			// or the direct-ingest + NATS-subscription paths both land). Swallow
			// the duplicate silently and return the existing row.
			const maybePgErr = err as { code?: string; cause?: unknown; message?: string };
			const causeErr = maybePgErr?.cause as { code?: string; message?: string } | undefined;
			const errMsg = `${maybePgErr?.message ?? ""} ${causeErr?.message ?? ""}`;
			const isUniqueViolation =
				maybePgErr?.code === "23505" ||
				causeErr?.code === "23505" ||
				errMsg.includes("uq_session_event_sequence") ||
				errMsg.includes("uq_session_events_source");
			if (isUniqueViolation) {
				// Source-event dup: return the existing row rather than retry.
				if (
					event.sourceEventId &&
					(errMsg.includes("uq_session_events_source") ||
						maybePgErr?.code === "23505")
				) {
					const [existing] = await database
						.select()
						.from(sessionEvents)
						.where(
							and(
								eq(sessionEvents.sessionId, sessionId),
								eq(sessionEvents.sourceEventId, event.sourceEventId),
							),
						)
						.limit(1);
					if (existing) return rowToEnvelope(existing);
				}
				continue;
			}
			throw err;
		}
	}
	throw new Error(`Failed to insert event after retries for session ${sessionId}`);
}

export async function listEvents(
	sessionId: string,
	opts: { afterSequence?: number; limit?: number } = {},
): Promise<SessionEventEnvelope[]> {
	const database = requireDb();
	const conditions = [eq(sessionEvents.sessionId, sessionId)];
	if (typeof opts.afterSequence === "number") {
		conditions.push(gt(sessionEvents.sequence, opts.afterSequence));
	}
	const rows = await database
		.select()
		.from(sessionEvents)
		.where(and(...conditions))
		.orderBy(asc(sessionEvents.sequence))
		.limit(opts.limit ?? 1000);
	return rows.map(rowToEnvelope);
}

/**
 * Append a user-side event (message, interrupt, tool_confirmation, custom
 * tool result). Returns the envelope; `processedAt` is null until the agent
 * picks it up via `ctx.wait_for_external_event`.
 */
export async function sendUserEvent(
	sessionId: string,
	event: UserEvent,
): Promise<SessionEventEnvelope> {
	return appendEvent(sessionId, {
		type: event.type,
		data: event as unknown as Record<string, unknown>,
		processedAt: null,
	});
}
