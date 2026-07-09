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

	async query(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "query" });
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

	it("delegates appends to the Postgres fallback until side effects are extracted", async () => {
		const client = new FakeBindingClient();
		const fallback = fakeFallback();
		const store = new DaprPostgresSessionEventLog(fallback, client);

		const event = await store.appendSessionEvent("session-1", {
			type: "agent.llm_usage",
			data: { input_tokens: 10 },
		});

		expect(event).toMatchObject({
			id: "evt-appended",
			sessionId: "session-1",
			type: "agent.llm_usage",
		});
		expect(fallback.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "agent.llm_usage",
			data: { input_tokens: 10 },
		});
		expect(client.calls).toHaveLength(0);
	});
});
