import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validateInternalToken: vi.fn(() => true),
	workflowData: {
		listSessionEvents: vi.fn(async () => [
			{
				id: 1,
				sessionId: "session-1",
				sequence: 7,
				type: "agent.message",
				data: { content: "hello" },
				sourceEventId: "source-1",
				processedAt: null,
				producerId: null,
				producerEpoch: null,
				createdAt: "2026-07-03T00:00:00.000Z",
				timestamp: "2026-07-03T00:00:00.000Z",
			},
		]),
	},
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(url = "http://localhost/api/internal/sessions/session-1/events") {
	return {
		params: { id: "session-1" },
		request: new Request(url),
		url: new URL(url),
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("internal session events route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.listSessionEvents.mockResolvedValue([
			{
				id: 1,
				sessionId: "session-1",
				sequence: 7,
				type: "agent.message",
				data: { content: "hello" },
				sourceEventId: "source-1",
				processedAt: null,
				producerId: null,
				producerEpoch: null,
				createdAt: "2026-07-03T00:00:00.000Z",
				timestamp: "2026-07-03T00:00:00.000Z",
			},
		]);
	});

	it("keeps session event reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listSessionEvents");
		expect(source).not.toContain("$lib/server/sessions/events");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("listEvents");
	});

	it("delegates positional reads and preserves the response shape", async () => {
		const response = (await GET(
			event(
				"http://localhost/api/internal/sessions/session-1/events?afterSequence=3&limit=25",
			) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessionId: "session-1",
			events: [
				{
					sequence: 7,
					type: "agent.message",
					data: { content: "hello" },
					sourceEventId: "source-1",
					createdAt: "2026-07-03T00:00:00.000Z",
				},
			],
			nextAfterSequence: 7,
			returned: 1,
			limit: 25,
		});
		expect(mocks.workflowData.listSessionEvents).toHaveBeenCalledWith(
			"session-1",
			{ afterSequence: 3, limit: 25 },
		);
	});

	it("requires the internal token before reading events", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 401);
		expect(mocks.workflowData.listSessionEvents).not.toHaveBeenCalled();
	});
});
