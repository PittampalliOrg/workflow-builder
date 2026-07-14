import { beforeEach, describe, expect, it, vi } from "vitest";
import { DaprPostgresScriptCallsStore } from "$lib/server/application/adapters/script-calls-dapr-postgres";

const row = [
	"call-1",
	2,
	"agent",
	"base-hash",
	0,
	"label",
	"phase",
	"prompt-sha",
	"done",
	"sess-1",
	{ content: "ok" },
	null,
	1,
	42,
	{ line: 7, column: 23 },
	"2026-07-09T12:00:00.000Z",
	"2026-07-09T12:00:01.000Z",
];

function mockClient() {
	return {
		exec: vi.fn().mockResolvedValue({ metadata: {}, rows: [], rowsAffected: 1 }),
		query: vi.fn(),
	};
}

describe("DaprPostgresScriptCallsStore", () => {
	let client: ReturnType<typeof mockClient>;
	let store: DaprPostgresScriptCallsStore;

	beforeEach(() => {
		client = mockClient();
		store = new DaprPostgresScriptCallsStore(client);
	});

	it("lists script calls through a fixed Dapr PostgreSQL query", async () => {
		client.query.mockResolvedValueOnce({
			metadata: {},
			rows: [row],
			rowsAffected: null,
		});

		await expect(store.listScriptCalls("exec-1")).resolves.toEqual([
			{
				callId: "call-1",
				seq: 2,
				kind: "agent",
				baseHash: "base-hash",
				occurrence: 0,
				label: "label",
				phase: "phase",
				promptSha256: "prompt-sha",
				status: "done",
				sessionId: "sess-1",
				result: { content: "ok" },
				errorCode: null,
				retries: 1,
				tokensUsed: 42,
				callSite: { line: 7, column: 23 },
				createdAt: "2026-07-09T12:00:00.000Z",
				updatedAt: "2026-07-09T12:00:01.000Z",
			},
		]);
		expect(client.query).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "workflow_script_calls.select_by_execution",
				collection: "workflow_script_calls",
				params: ["exec-1"],
				paramNames: ["workflow_execution_id"],
			}),
		);
	});

	it("upserts with exec and then reads the row by primary key", async () => {
		client.query.mockResolvedValueOnce({
			metadata: {},
			rows: [row],
			rowsAffected: null,
		});

		await expect(
			store.upsertScriptCall("exec-1", "call-1", {
				seq: 2,
				status: "done",
				result: { content: "ok", apiToken: "secret" },
			}),
		).resolves.toMatchObject({ callId: "call-1", status: "done" });

		expect(client.exec).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "workflow_script_calls.upsert",
				collection: "workflow_script_calls",
				paramNames: expect.arrayContaining(["workflow_execution_id", "call_id", "result"]),
				params: expect.arrayContaining([
					"exec-1",
					"call-1",
					JSON.stringify({ content: "ok", apiToken: "secret" }),
				]),
				spanParams: expect.arrayContaining([
					"exec-1",
					"call-1",
					{ content: "ok", apiToken: "secret" },
				]),
			}),
		);
		expect(client.query).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: "workflow_script_calls.select_by_pk",
				params: ["exec-1", "call-1"],
			}),
		);
	});
});
