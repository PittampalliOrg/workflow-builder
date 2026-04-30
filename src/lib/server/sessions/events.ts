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
		producerId: row.producerId ?? null,
		producerEpoch: row.producerEpoch ?? null,
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
 * Append an event to a session's log. Sequence is computed server-side via a
 * max+1 lookup while holding a per-session advisory transaction lock. The lock
 * keeps bursts from runtime event emitters from exhausting retries on the
 * unique (session_id, sequence) constraint while still allowing different
 * sessions to append concurrently.
 */
export async function appendEvent(
	sessionId: string,
	event: {
		type: string;
		data?: Record<string, unknown>;
		processedAt?: Date | null;
		sourceEventId?: string | null;
		producerId?: string | null;
		producerEpoch?: string | null;
	},
): Promise<SessionEventEnvelope> {
	const database = requireDb();
	// Retry loop is retained as a guard for transaction aborts and source-event
	// duplicates delivered through more than one ingest path.
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			const row = await database.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${sessionId})::bigint)`,
				);
				const [{ maxSeq }] = await tx
					.select({
						maxSeq: sql<number>`coalesce(max(${sessionEvents.sequence}), 0)`,
					})
					.from(sessionEvents)
					.where(eq(sessionEvents.sessionId, sessionId));
				const nextSeq = Number(maxSeq ?? 0) + 1;
				const [inserted] = await tx
					.insert(sessionEvents)
					.values({
						sessionId,
						sequence: nextSeq,
						type: event.type,
						data: event.data ?? {},
						processedAt: event.processedAt ?? null,
						sourceEventId: event.sourceEventId ?? null,
						producerId: event.producerId ?? null,
						producerEpoch: event.producerEpoch ?? null,
					})
					.returning();
				return inserted;
			});
			// Bench metrics aggregation (fire-and-forget). When dapr-agent-py
			// emits an `agent.llm_usage` event for a session linked to a
			// benchmark_run_instances row, atomically roll the call's tokens
			// into that row's `usage` jsonb. The UPDATE is a no-op for
			// non-benchmark sessions (no row matches the session_id).
			if (event.type === "agent.llm_usage") {
				await aggregateLlmUsageIntoBenchmarkInstance(
					sessionId,
					(event.data ?? {}) as Record<string, unknown>,
				);
			}
			if (event.type === "instance.metrics_summary") {
				await applyInstanceMetricsSummaryToBenchmark(
					sessionId,
					(event.data ?? {}) as Record<string, unknown>,
				);
			}
			return rowToEnvelope(row);
		} catch (err) {
			// Unique violation on sequence should be rare with the advisory lock,
			// but keep retrying if the transaction raced with older app versions.
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
 * Roll a single dapr-agent-py `agent.llm_usage` event's tokens into the
 * matching benchmark_run_instances row. No-op when no benchmark instance
 * is linked to this session (UI-driven sessions, evaluation-driven sessions).
 *
 * The atomic SQL UPDATE keeps tokens consistent under the bursty event
 * stream — every LLM call increments by per-call deltas without read-modify-
 * write races between concurrent benchmark sessions.
 */
async function aggregateLlmUsageIntoBenchmarkInstance(
	sessionId: string,
	data: Record<string, unknown>,
): Promise<void> {
	// `success: false` events are emitted on circuit-breaker tripping so the UI
	// can render the partial usage that did get spent. We still want to roll
	// those tokens into the benchmark row for accurate cost; they were paid
	// for either way. The agent emits `success` boolean on every call.
	if (data.success === false) {
		// Failures still consume tokens; record them.
	}
	// Tokens are integers; ttft_ms arrives as a millisecond float and must be
	// rounded BEFORE binding because Postgres binds JS floats as numeric, and
	// COALESCE(numeric, bigint) raises a type-mismatch error that fails the
	// whole UPDATE. Rounding to int + binding integer side-steps the cast.
	const inputTokens = Math.round(Number(data.input_tokens ?? 0)) || 0;
	const outputTokens = Math.round(Number(data.output_tokens ?? 0)) || 0;
	const cacheRead = Math.round(Number(data.cache_read_input_tokens ?? 0)) || 0;
	const cacheCreate = Math.round(Number(data.cache_creation_input_tokens ?? 0)) || 0;
	const ttftMsRaw = Number(data.ttft_ms ?? 0);
	const ttftMs = Number.isFinite(ttftMsRaw) && ttftMsRaw > 0 ? Math.round(ttftMsRaw) : null;
	const model = typeof data.model === "string" ? data.model : null;
	if (inputTokens + outputTokens + cacheRead + cacheCreate <= 0) return;
	try {
		const database = requireDb();
		await database.execute(sql`
			UPDATE benchmark_run_instances
			SET usage = jsonb_build_object(
				'input_tokens',
					COALESCE((usage->>'input_tokens')::bigint, 0) + ${inputTokens}::bigint,
				'output_tokens',
					COALESCE((usage->>'output_tokens')::bigint, 0) + ${outputTokens}::bigint,
				'cache_read_input_tokens',
					COALESCE((usage->>'cache_read_input_tokens')::bigint, 0) + ${cacheRead}::bigint,
				'cache_creation_input_tokens',
					COALESCE((usage->>'cache_creation_input_tokens')::bigint, 0) + ${cacheCreate}::bigint,
				'llm_call_count',
					COALESCE((usage->>'llm_call_count')::bigint, 0) + 1,
				'ttft_first_ms',
					COALESCE((usage->>'ttft_first_ms')::bigint, ${ttftMs}::bigint),
				'model',
					COALESCE(${model}, usage->>'model'),
				'cost_usd',
					(usage->>'cost_usd')::float8
			),
			updated_at = NOW()
			WHERE session_id = ${sessionId}
		`);
	} catch (err) {
		// Don't fail the event ingestion on metric-rollup errors; log and move on.
		console.warn(
			"[bench-metrics] aggregateLlmUsageIntoBenchmarkInstance failed",
			(err as Error)?.message ?? err,
		);
	}
}

/**
 * Land a single dapr-agent-py `instance.metrics_summary` event onto the matching
 * benchmark_run_instances row. Emitted exactly once per agent_workflow run from
 * the finally-block (gated on non-replay), so this is a non-incremental UPSERT
 * of the six counters. No-op for non-benchmark sessions.
 */
async function applyInstanceMetricsSummaryToBenchmark(
	sessionId: string,
	data: Record<string, unknown>,
): Promise<void> {
	if (!db) return;
	try {
		const turnCount = readNumericOrNull(data, "turn_count");
		const toolCallCount = readNumericOrNull(data, "tool_call_count");
		const ttftFirstMs = readNumericOrNull(data, "ttft_first_ms");
		const ttftFirstToolMs = readNumericOrNull(data, "ttft_first_tool_ms");
		const terminationReason = readStringOrNull(data, "termination_reason");
		const histogramRaw = data.tool_histogram;
		const histogram =
			histogramRaw && typeof histogramRaw === "object" && !Array.isArray(histogramRaw)
				? (histogramRaw as Record<string, number>)
				: {};
		// Phase B Python emits `instance.metrics_summary` from agent_workflow's
		// finally block, which fires on every Dapr replay tick. Different replay
		// ticks see different in-memory counter states (0 before call_llm activity
		// completes write-back, then 1+ after). If we OVERWROTE the row each time,
		// later 0-emits would clobber a real high-water mark.
		// Fix: use GREATEST() for monotonic counters; coalesce on string/jsonb.
		// Termination reason: prefer the latest non-end_turn value (specific
		// signals like circuit_breaker_* should win over the default end_turn).
		// Tool histogram: keep whichever has more entries (proxy for completeness).
		await db.execute(sql`
			UPDATE benchmark_run_instances
			SET turn_count = GREATEST(COALESCE(turn_count, 0), COALESCE(${turnCount}, 0)::int),
				tool_call_count = GREATEST(COALESCE(tool_call_count, 0), COALESCE(${toolCallCount}, 0)::int),
				termination_reason = CASE
					WHEN ${terminationReason}::text IS NULL THEN termination_reason
					WHEN termination_reason IS NULL THEN ${terminationReason}::text
					WHEN termination_reason = 'end_turn' AND ${terminationReason}::text != 'end_turn' THEN ${terminationReason}::text
					ELSE termination_reason
				END,
				ttft_first_ms = COALESCE(ttft_first_ms, ${ttftFirstMs}::int),
				ttft_first_tool_ms = COALESCE(ttft_first_tool_ms, ${ttftFirstToolMs}::int),
				tool_histogram = CASE
					WHEN ${JSON.stringify(histogram)}::jsonb = '{}'::jsonb THEN tool_histogram
					ELSE ${JSON.stringify(histogram)}::jsonb
				END,
				updated_at = NOW()
			WHERE session_id = ${sessionId}
		`);
	} catch (err) {
		console.warn(
			"[bench-metrics] applyInstanceMetricsSummaryToBenchmark failed",
			(err as Error)?.message ?? err,
		);
	}
}

function readNumericOrNull(data: Record<string, unknown>, key: string): number | null {
	const raw = data[key];
	if (raw === null || raw === undefined) return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

function readStringOrNull(data: Record<string, unknown>, key: string): string | null {
	const raw = data[key];
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed ? trimmed : null;
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
