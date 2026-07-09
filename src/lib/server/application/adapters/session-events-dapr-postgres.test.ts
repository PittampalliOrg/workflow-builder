import { describe, expect, it, vi } from "vitest";
import type {
	DaprPostgresBindingCall,
	DaprPostgresBindingResult,
} from "$lib/server/application/adapters/dapr-postgres-binding";
import { DaprPostgresSessionEventLog } from "$lib/server/application/adapters/session-events-dapr-postgres";
import type {
	AppendSessionEventInput,
	SessionEventLog,
} from "$lib/server/application/ports";
import type { SessionEventEnvelope } from "$lib/types/sessions";

class FakeBindingClient {
	calls: DaprPostgresBindingCall[] = [];
	queryRows = new Map<string, unknown[][]>();
	queryErrors = new Map<string, Error[]>();

	async query(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "query" });
		const errors = this.queryErrors.get(input.summary ?? "");
		const error = errors?.shift();
		if (error) throw error;
		return {
			metadata: {},
			rows: this.queryRows.get(input.summary ?? "") ?? [],
			rowsAffected: null,
		};
	}
}

function eventRow(overrides: Partial<SessionEventEnvelope> = {}) {
	return [
		overrides.id ?? "evt-1",
		overrides.sessionId ?? "session-1",
		overrides.sequence ?? 1,
		overrides.type ?? "agent.llm_usage",
		JSON.stringify(overrides.data ?? { input_tokens: 100 }),
		overrides.processedAt ?? null,
		overrides.sourceEventId ?? null,
		overrides.producerId ?? "agent-1",
		overrides.producerEpoch ?? "epoch-1",
		overrides.createdAt ?? "2026-07-09T12:00:00.000Z",
	];
}

function fakeFallback(): SessionEventLog {
	return {
		appendSessionEvent: vi.fn(
			async (
				sessionId: string,
				event: AppendSessionEventInput,
			): Promise<SessionEventEnvelope> => ({
				id: "evt-appended",
				sessionId,
				sequence: 2,
				type: event.type,
				data: event.data ?? {},
				processedAt: event.processedAt?.toISOString() ?? null,
				sourceEventId: event.sourceEventId ?? null,
				producerId: event.producerId ?? null,
				producerEpoch: event.producerEpoch ?? null,
				createdAt: "2026-07-09T12:00:01.000Z",
				timestamp: "2026-07-09T12:00:01.000Z",
			}),
		),
		getSessionEvent: vi.fn(),
		listSessionEvents: vi.fn(),
	};
}

describe("DaprPostgresSessionEventLog", () => {
	it("lists session events through the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("session_events.select_by_session", [
			eventRow({
				id: "evt-1",
				type: "agent.llm_usage",
				data: { input_tokens: 100, content: "full", preview: "short" },
			}),
		]);
		const store = new DaprPostgresSessionEventLog(fakeFallback(), client);

		const events = await store.listSessionEvents("session-1", {
			afterSequence: 0,
			limit: 10,
			preview: true,
		});

		expect(events).toEqual([
			expect.objectContaining({
				id: "evt-1",
				sessionId: "session-1",
				sequence: 1,
				type: "agent.llm_usage",
				data: { input_tokens: 100, preview: "short" },
				createdAt: "2026-07-09T12:00:00.000Z",
			}),
		]);
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "session_events.select_by_session",
			collection: "session_events",
			params: ["session-1", 0, null, 10],
			paramNames: [
				"session_id",
				"after_sequence",
				"at_or_before_sequence",
				"limit",
			],
		});
	});

	it("gets one session event through the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("session_events.select_by_id", [
			eventRow({ id: "evt-2", sequence: 2, type: "agent.message" }),
		]);
		const store = new DaprPostgresSessionEventLog(fakeFallback(), client);

		const event = await store.getSessionEvent({
			sessionId: "session-1",
			eventId: "evt-2",
		});

		expect(event).toMatchObject({
			id: "evt-2",
			sessionId: "session-1",
			sequence: 2,
			type: "agent.message",
		});
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "session_events.select_by_id",
			collection: "session_events",
			params: ["session-1", "evt-2"],
			paramNames: ["session_id", "id"],
		});
	});

	it("appends session events through the binding and runs post-append hooks", async () => {
		const client = new FakeBindingClient();
		const fallback = fakeFallback();
		const postAppendHook = vi.fn(async () => {});
		client.queryRows.set("session_events.insert", [
			eventRow({
				id: "evt-appended",
				sessionId: "session-1",
				sequence: 2,
				type: "agent.llm_usage",
				data: { input_tokens: 10 },
				sourceEventId: "source-1",
			}),
		]);
		const store = new DaprPostgresSessionEventLog(
			fallback,
			client,
			postAppendHook,
		);

		const event = await store.appendSessionEvent("session-1", {
			type: "agent.llm_usage",
			data: { input_tokens: 10, ignored: undefined },
			sourceEventId: "source-1",
			producerId: "agent-1",
		});

		expect(event).toMatchObject({
			id: "evt-appended",
			sessionId: "session-1",
			type: "agent.llm_usage",
		});
		expect(fallback.appendSessionEvent).not.toHaveBeenCalled();
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "session_events.insert",
			collection: "session_events",
			params: [
				"session-1",
				"agent.llm_usage",
				JSON.stringify({ input_tokens: 10 }),
				null,
				"source-1",
				"agent-1",
				null,
			],
			spanParams: [
				"session-1",
				"agent.llm_usage",
				{ input_tokens: 10 },
				null,
				"source-1",
				"agent-1",
				null,
			],
			paramNames: [
				"session_id",
				"type",
				"data",
				"processed_at",
				"source_event_id",
				"producer_id",
				"producer_epoch",
			],
		});
		expect(client.calls[0]?.sql).toContain("pg_advisory_xact_lock");
		expect(client.calls[0]?.sql).toContain("RETURNING");
		expect(postAppendHook).toHaveBeenCalledWith("session-1", "agent.llm_usage", {
			input_tokens: 10,
		});
	});

	it("returns an existing source event when a duplicate append races", async () => {
		const client = new FakeBindingClient();
		const duplicate = new Error(
			'23505 duplicate key value violates unique constraint "uq_session_events_source"',
		);
		client.queryErrors.set("session_events.insert", [duplicate]);
		client.queryRows.set("session_events.select_by_source_event", [
			eventRow({
				id: "evt-existing",
				sessionId: "session-1",
				sourceEventId: "source-1",
			}),
		]);
		const postAppendHook = vi.fn(async () => {});
		const store = new DaprPostgresSessionEventLog(
			fakeFallback(),
			client,
			postAppendHook,
		);

		const event = await store.appendSessionEvent("session-1", {
			type: "agent.llm_usage",
			data: { input_tokens: 10 },
			sourceEventId: "source-1",
		});

		expect(event).toMatchObject({
			id: "evt-existing",
			sessionId: "session-1",
			sourceEventId: "source-1",
		});
		expect(client.calls.map((call) => call.summary)).toEqual([
			"session_events.insert",
			"session_events.select_by_source_event",
		]);
		expect(postAppendHook).not.toHaveBeenCalled();
	});
});
