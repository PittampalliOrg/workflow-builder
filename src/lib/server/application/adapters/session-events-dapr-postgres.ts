import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	dateValue,
	jsonValue,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import { PostgresSessionEventLog } from "$lib/server/application/adapters/session-events";
import type {
	AppendSessionEventInput,
	ListSessionEventsInput,
	SessionEventLog,
} from "$lib/server/application/ports";
import {
	rowToEnvelope,
	type SessionEventEnvelopeRow,
} from "$lib/server/sessions/event-envelope";
import type { SessionEventEnvelope } from "$lib/types/sessions";

type BindingClient = Pick<DaprPostgresBindingClient, "query">;
type PostgresSessionEventDatabase = ConstructorParameters<
	typeof PostgresSessionEventLog
>[0];

const SESSION_EVENT_COLUMNS = `
	id,
	session_id,
	sequence,
	type,
	data,
	processed_at,
	source_event_id,
	producer_id,
	producer_epoch,
	created_at
`;

function rowToSessionEvent(row: readonly unknown[]): SessionEventEnvelopeRow {
	return {
		id: stringValue(row[0]),
		sessionId: stringValue(row[1]),
		sequence: numberValue(row[2]),
		type: stringValue(row[3]),
		data: jsonValue<Record<string, unknown>>(row[4], {}),
		processedAt: row[5] == null ? null : dateValue(row[5]),
		sourceEventId: stringOrNull(row[6]),
		producerId: stringOrNull(row[7]),
		producerEpoch: stringOrNull(row[8]),
		createdAt: dateValue(row[9]),
	};
}

export class DaprPostgresSessionEventLog implements SessionEventLog {
	constructor(
		private readonly postgresFallback: SessionEventLog,
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
	) {}

	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope> {
		// Append still owns benchmark, timing, and goal-loop side effects in the
		// Postgres implementation. Keep writes there until those effects are split
		// behind a post-append hook that can safely run after a binding insert.
		return this.postgresFallback.appendSessionEvent(sessionId, event);
	}

	async getSessionEvent(input: {
		sessionId: string;
		eventId: string;
	}): Promise<SessionEventEnvelope | null> {
		const result = await this.client.query({
			summary: "session_events.select_by_id",
			collection: "session_events",
			sql: `
				SELECT ${SESSION_EVENT_COLUMNS}
				FROM session_events
				WHERE session_id = $1 AND id = $2
				LIMIT 1
			`,
			params: [input.sessionId, input.eventId],
			paramNames: ["session_id", "id"],
		});
		const row = result.rows[0];
		return row ? rowToEnvelope(rowToSessionEvent(row), { preview: false }) : null;
	}

	async listSessionEvents(
		sessionId: string,
		input: ListSessionEventsInput = {},
	): Promise<SessionEventEnvelope[]> {
		const limit =
			typeof input.limit === "number" ? Math.max(1, Math.trunc(input.limit)) : null;
		const result = await this.client.query({
			summary: "session_events.select_by_session",
			collection: "session_events",
			sql: `
				SELECT ${SESSION_EVENT_COLUMNS}
				FROM session_events
				WHERE session_id = $1
					AND ($2::int IS NULL OR sequence > $2::int)
					AND ($3::int IS NULL OR sequence <= $3::int)
				ORDER BY sequence ASC
				LIMIT COALESCE($4::int, 2147483647)
			`,
			params: [
				sessionId,
				input.afterSequence ?? null,
				input.atOrBeforeSequence ?? null,
				limit,
			],
			paramNames: [
				"session_id",
				"after_sequence",
				"at_or_before_sequence",
				"limit",
			],
		});
		return result.rows.map((row) =>
			rowToEnvelope(rowToSessionEvent(row), { preview: input.preview }),
		);
	}
}

export function createDaprPostgresSessionEventLog(
	database: PostgresSessionEventDatabase,
): DaprPostgresSessionEventLog {
	return new DaprPostgresSessionEventLog(new PostgresSessionEventLog(database));
}
