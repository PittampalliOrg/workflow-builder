import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const dbState = vi.hoisted(() => ({
	db: null as unknown,
}));

vi.mock("$lib/server/db", () => ({
	get db() {
		return dbState.db;
	},
}));

vi.mock("$lib/server/sessions/registry", () => ({
	getSession: (...args: unknown[]) => getSessionMock(...args),
}));

import { GET } from "./[id]/control/context-usage/+server";

describe("GET /api/v1/sessions/:id/control/context-usage", () => {
	beforeEach(() => {
		getSessionMock.mockReset();
		dbState.db = dbReturningRows([
			[{ eventCount: 3, totalBytes: 1234, turns: 2 }],
			[{ data: { context_source: "dapr_state", context_input_tokens: 24000 } }],
			[{ data: { context_source: "provider_usage", context_input_tokens: 23000 } }],
		]);
		getSessionMock.mockResolvedValue({ id: "session-1", usage: { input: 10 } });
	});

	it("returns llm turn counts from the current session event aggregate", async () => {
		const response = (await GET(event())) as Response;
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			sessionId: "session-1",
			usage: { input: 10 },
			activeContext: { context_source: "dapr_state", context_input_tokens: 24000 },
			lastProviderContext: { context_source: "provider_usage", context_input_tokens: 23000 },
			events: {
				total: 3,
				totalBytes: 1234,
				llmTurns: 2,
			},
		});
		expect(getSessionMock).toHaveBeenCalledWith("session-1");
	});
});

function dbReturningRows(resultSets: Array<Array<Record<string, unknown>>>) {
	let index = 0;
	return {
		select: vi.fn(() => {
			const rows = resultSets[index++] ?? [];
			const query = {
				from: vi.fn(() => query),
				where: vi.fn(() => query),
				orderBy: vi.fn(() => query),
				limit: vi.fn(async () => rows),
				then: (resolve: (value: Array<Record<string, unknown>>) => void, reject: (reason: unknown) => void) =>
					Promise.resolve(rows).then(resolve, reject),
			};
			return query;
		}),
	};
}

function event(): never {
	return {
		params: { id: "session-1" },
		locals: {
			session: {
				userId: "user-1",
			},
		},
	} as never;
}
