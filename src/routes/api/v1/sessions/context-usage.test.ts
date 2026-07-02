import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflowData: {
		getSessionContextUsage: vi.fn(async () => ({
			sessionId: "session-1",
			usage: { input: 10 },
			activeContext: {
				context_source: "dapr_state",
				context_input_tokens: 24000,
			},
			lastProviderContext: {
				context_source: "provider_usage",
				context_input_tokens: 23000,
			},
			events: {
				total: 3,
				totalBytes: 1234,
				llmTurns: 2,
			},
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./[id]/control/context-usage/+server";

describe("GET /api/v1/sessions/:id/control/context-usage", () => {
	beforeEach(() => {
		vi.clearAllMocks();
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
		expect(mocks.workflowData.getSessionContextUsage).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: null,
		});
	});
});

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
