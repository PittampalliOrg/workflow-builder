import { DaprPostgresBindingClient } from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	dateValue,
	jsonParam,
	jsonValue,
	numberValue,
	stringOrNull,
	stringValue,
} from "$lib/server/application/adapters/dapr-postgres-rows";
import {
	PostgresSessionEventLog,
	runSessionEventPostAppendHooks,
} from "$lib/server/application/adapters/session-events";
import type {
	AppendSessionEventInput,
	ListSessionEventsInput,
	SessionEventLog,
} from "$lib/server/application/ports";
import { generateId } from "$lib/server/utils/id";
import {
	rowToEnvelope,
	sanitizeSessionEventDataForPostgres,
	type SessionEventEnvelopeRow,
} from "$lib/server/sessions/event-envelope";
import type { SessionEventEnvelope } from "$lib/types/sessions";

type BindingClient = Pick<DaprPostgresBindingClient, "query" | "exec">;
type PostgresSessionEventDatabase = ConstructorParameters<
	typeof PostgresSessionEventLog
>[0];
type PostAppendHook = (
	sessionId: string,
	eventType: string,
	cleanData: Record<string, unknown>,
) => Promise<void>;

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

function isUniqueViolation(error: unknown): boolean {
	const maybeError = error as {
		code?: string;
		cause?: unknown;
		message?: string;
	};
	const cause = maybeError?.cause as
		| { code?: string; message?: string }
		| undefined;
	const message = `${maybeError?.message ?? ""} ${cause?.message ?? ""}`;
	return (
		maybeError?.code === "23505" ||
		cause?.code === "23505" ||
		message.includes("23505") ||
		message.includes("uq_session_event_sequence") ||
		message.includes("uq_session_events_source") ||
		message.includes("duplicate key value")
	);
}

export class DaprPostgresSessionEventLog implements SessionEventLog {
	constructor(
		_postgresFallback: SessionEventLog,
		private readonly client: BindingClient = new DaprPostgresBindingClient(),
		private readonly postAppendHook: PostAppendHook = async () => {},
	) {}

	async appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope> {
		const cleanData = sanitizeSessionEventDataForPostgres(event.data ?? {});
		const eventId = generateId();
		for (let attempt = 0; attempt < 5; attempt += 1) {
			try {
				await this.client.exec({
					summary: "session_events.insert",
					collection: "session_events",
					sql: `
						INSERT INTO session_events (
							id,
							session_id,
							sequence,
							type,
							data,
							processed_at,
							source_event_id,
							producer_id,
							producer_epoch
						)
						SELECT
							$1,
							$2,
							next_sequence.sequence,
							$3,
							$4::jsonb,
							$5,
							$6,
							$7,
							$8
						FROM (
							SELECT pg_advisory_xact_lock(hashtext($2)::bigint)
						) AS lock,
						LATERAL (
							SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
						FROM session_events
						WHERE session_id = $2
						) AS next_sequence
					`,
					params: [
						eventId,
						sessionId,
						event.type,
						jsonParam(cleanData),
						event.processedAt?.toISOString() ?? null,
						event.sourceEventId ?? null,
						event.producerId ?? null,
						event.producerEpoch ?? null,
					],
					spanParams: [
						eventId,
						sessionId,
						event.type,
						cleanData,
						event.processedAt?.toISOString() ?? null,
						event.sourceEventId ?? null,
						event.producerId ?? null,
						event.producerEpoch ?? null,
					],
					paramNames: [
						"id",
						"session_id",
						"type",
						"data",
						"processed_at",
						"source_event_id",
						"producer_id",
						"producer_epoch",
					],
				});
				const inserted = await this.getSessionEvent({
					sessionId,
					eventId,
				});
				if (!inserted)
					throw new Error(
						"Dapr PostgreSQL session event insert was not persisted",
					);
				await this.postAppendHook(sessionId, event.type, cleanData);
				return inserted;
			} catch (error) {
				if (!isUniqueViolation(error)) throw error;
				if (event.sourceEventId) {
					const existing = await this.selectBySourceEventId(
						sessionId,
						event.sourceEventId,
					);
					if (existing) return existing;
				}
			}
		}
		throw new Error(
			`Failed to insert event after retries for session ${sessionId}`,
		);
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
		return row
			? rowToEnvelope(rowToSessionEvent(row), { preview: false })
			: null;
	}

	async listSessionEvents(
		sessionId: string,
		input: ListSessionEventsInput = {},
	): Promise<SessionEventEnvelope[]> {
		const limit =
			typeof input.limit === "number"
				? Math.max(1, Math.trunc(input.limit))
				: null;
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

	/** See PostgresSessionEventLog.claimUnraisedTeamEvents — same contract,
	 * routed through the Dapr postgres binding. UPDATE...RETURNING keeps the
	 * claim atomic (concurrent deliveries can never claim the same row). */
	async claimUnraisedTeamEvents(
		sessionId: string,
	): Promise<Array<{ id: string; sequence: number; data: Record<string, unknown> }>> {
		const result = await this.client.query({
			summary: "session_events.claim_unraised_team_events",
			collection: "session_events",
			sql: `
				UPDATE session_events
				SET processed_at = now()
				WHERE session_id = $1
					AND processed_at IS NULL
					AND type = 'user.message'
					AND data->>'origin' IN ('teammate-message', 'team-broadcast', 'team-idle')
				RETURNING id, sequence, data
			`,
			params: [sessionId],
			paramNames: ["session_id"],
		});
		// Binding rows are POSITIONAL arrays matching the RETURNING list.
		return result.rows
			.map((row) => {
				const rawData = row[2];
				const data =
					typeof rawData === "string"
						? (JSON.parse(rawData) as Record<string, unknown>)
						: ((rawData ?? {}) as Record<string, unknown>);
				return {
					id: String(row[0]),
					sequence: Number(row[1]),
					data,
				};
			})
			.sort((a, b) => a.sequence - b.sequence);
	}

	async unclaimSessionEvents(sessionId: string, ids: string[]): Promise<void> {
		// Per-id exec: the Dapr postgres binding JSON-serializes params, so a JS
		// array does not bind reliably as text[]. Unclaim is a rare failure path
		// with a handful of rows — N tiny statements is fine.
		for (const id of ids) {
			await this.client.exec({
				summary: "session_events.unclaim",
				collection: "session_events",
				sql: `
					UPDATE session_events
					SET processed_at = NULL
					WHERE session_id = $1 AND id = $2
				`,
				params: [sessionId, id],
				paramNames: ["session_id", "id"],
			});
		}
	}

	private async selectBySourceEventId(
		sessionId: string,
		sourceEventId: string,
	): Promise<SessionEventEnvelope | null> {
		const result = await this.client.query({
			summary: "session_events.select_by_source_event",
			collection: "session_events",
			sql: `
				SELECT ${SESSION_EVENT_COLUMNS}
				FROM session_events
				WHERE session_id = $1 AND source_event_id = $2
				LIMIT 1
			`,
			params: [sessionId, sourceEventId],
			paramNames: ["session_id", "source_event_id"],
		});
		const row = result.rows[0];
		return row
			? rowToEnvelope(rowToSessionEvent(row), { preview: false })
			: null;
	}
}

export function createDaprPostgresSessionEventLog(
	database: PostgresSessionEventDatabase,
): DaprPostgresSessionEventLog {
	return new DaprPostgresSessionEventLog(
		new PostgresSessionEventLog(database),
		new DaprPostgresBindingClient(),
		(sessionId, eventType, cleanData) =>
			runSessionEventPostAppendHooks(sessionId, eventType, cleanData, database),
	);
}
