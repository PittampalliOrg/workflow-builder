import type { SessionEventEnvelope } from "$lib/types/sessions";

export type SessionEventEnvelopeRow = {
	id: string;
	sessionId: string;
	sequence: number;
	type: string;
	data: unknown;
	processedAt: Date | null;
	sourceEventId: string | null;
	producerId: string | null;
	producerEpoch: string | null;
	createdAt: Date;
};

export function rowToEnvelope(
	row: SessionEventEnvelopeRow,
	opts: { preview?: boolean } = {},
): SessionEventEnvelope {
	const rawData = (row.data as Record<string, unknown>) ?? {};
	const data = opts.preview ? stripFullPayload(rawData) : rawData;
	const createdAt = row.createdAt.toISOString();
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
		createdAt,
		timestamp: createdAt,
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

function stripNulBytes(value: string): string {
	return value.includes("\u0000") ? value.replace(/\u0000/g, "") : value;
}

export function sanitizeSessionEventDataForPostgres<T>(value: T): T {
	if (typeof value === "string") return stripNulBytes(value) as T;
	if (Array.isArray(value)) {
		return value.map((entry) =>
			sanitizeSessionEventDataForPostgres(entry),
		) as T;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(
			value as Record<string, unknown>,
		)) {
			out[stripNulBytes(key)] = sanitizeSessionEventDataForPostgres(entry);
		}
		return out as T;
	}
	return value;
}
