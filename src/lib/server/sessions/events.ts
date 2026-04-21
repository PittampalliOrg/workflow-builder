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

function rowToEnvelope(
	row: SessionEventRow,
	opts: { preview?: boolean } = {},
): SessionEventEnvelope {
	const rawData = (row.data as Record<string, unknown>) ?? {};
	const data = opts.preview ? stripFullPayload(rawData) : rawData;
	return {
		id: row.id,
		sessionId: row.sessionId,
		sequence: row.sequence,
		type: row.type,
		data,
		processedAt: row.processedAt ? row.processedAt.toISOString() : null,
		sourceEventId: row.sourceEventId ?? null,
		createdAt: row.createdAt.toISOString(),
	};
}

/**
 * Replace the full payload fields with their `preview` counterparts so the
 * SSE stream and list endpoints default to sending compact rows. The UI
 * pulls the full envelope on demand via /api/v1/sessions/[id]/events/[eventId].
 *
 * Supported preview fields (set by the agent side, see
 * services/dapr-agent-py/src/event_publisher.py::_cma_shape +
 * services/dapr-agent-py/src/main.py run_tool()):
 *   - `preview` for llm_complete content (already normalized to `content`
 *     array on the agent side; we strip `content` and leave `preview`).
 *   - `input_preview` for tool_call_start input.
 *   - `output_preview` for tool_call_end output.
 *
 * Other fields are passed through unchanged.
 */
function stripFullPayload(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data };
	if ("preview" in out && "content" in out) {
		delete out.content;
	}
	if ("input_preview" in out && "input" in out) {
		delete out.input;
	}
	if ("output_preview" in out && "output" in out) {
		delete out.output;
	}
	return out;
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
	opts: { afterSequence?: number; limit?: number; preview?: boolean } = {},
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
	return rows.map((r) => rowToEnvelope(r, { preview: opts.preview }));
}

/**
 * Fetch a single event by id. Returns the full (un-stripped) envelope. Used
 * by the debug panel's "Load full payload" affordance when the SSE stream
 * sent a preview-only shape.
 */
export async function getEvent(
	sessionId: string,
	eventId: string,
): Promise<SessionEventEnvelope | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessionEvents)
		.where(
			and(eq(sessionEvents.sessionId, sessionId), eq(sessionEvents.id, eventId)),
		)
		.limit(1);
	return row ? rowToEnvelope(row, { preview: false }) : null;
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
