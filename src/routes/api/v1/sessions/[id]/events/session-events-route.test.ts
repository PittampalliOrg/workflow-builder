import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		getSessionEventStreamSnapshot: vi.fn(async () => ({
			id: "session-1",
			projectId: "project-1",
			status: "running",
		})),
		listSessionEvents: vi.fn(async () => [
			{
				id: "event-1",
				sessionId: "session-1",
				sequence: 8,
				type: "user.message",
				data: { content: [{ type: "text", text: "hello" }] },
				processedAt: null,
				sourceEventId: null,
				producerId: null,
				producerEpoch: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				timestamp: "2026-01-01T00:00:00.000Z",
			},
		]),
		appendSessionUserEvents: vi.fn(async () => ({
			status: "ok" as const,
			events: [
				{
					id: "event-2",
					sessionId: "session-1",
					sequence: 9,
					type: "user.message",
					data: { content: [{ type: "text", text: "next" }] },
					processedAt: null,
					sourceEventId: null,
					producerId: null,
					producerEpoch: null,
					createdAt: "2026-01-01T00:01:00.000Z",
					timestamp: "2026-01-01T00:01:00.000Z",
				},
			],
		})),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET, POST } from "./+server";

function baseLocals() {
	return { session: { userId: "user-1", projectId: "project-1" } };
}

function getEvent(overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		url: new URL(
			"http://test.local/api/v1/sessions/session-1/events?afterSequence=7&limit=5&preview=0",
		),
		locals: baseLocals(),
		...overrides,
	};
}

function postEvent(body: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		request: new Request("http://test.local/api/v1/sessions/session-1/events", {
			method: "POST",
			body: JSON.stringify(body),
		}),
		locals: baseLocals(),
		...overrides,
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

describe("session events route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getSessionEventStreamSnapshot.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			status: "running",
		});
		mocks.workflowData.appendSessionUserEvents.mockResolvedValue({
			status: "ok",
			events: [
				{
					id: "event-2",
					sessionId: "session-1",
					sequence: 9,
					type: "user.message",
					data: { content: [{ type: "text", text: "next" }] },
					processedAt: null,
					sourceEventId: null,
					producerId: null,
					producerEpoch: null,
					createdAt: "2026-01-01T00:01:00.000Z",
					timestamp: "2026-01-01T00:01:00.000Z",
				},
			],
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getSessionEventStreamSnapshot");
		expect(source).toContain("workflowData.listSessionEvents");
		expect(source).toContain("workflowData.appendSessionUserEvents");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/sessions/");
	});

	it("lists events through workflowData after scope check", async () => {
		const response = (await GET(getEvent() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			events: [{ id: "event-1", sequence: 8 }],
		});
		expect(mocks.workflowData.getSessionEventStreamSnapshot).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
		expect(mocks.workflowData.listSessionEvents).toHaveBeenCalledWith("session-1", {
			afterSequence: 7,
			limit: 5,
			preview: false,
		});
	});

	it("appends user events through workflowData", async () => {
		const userEvent = {
			type: "user.message",
			content: [{ type: "text", text: "next" }],
		};
		const response = (await POST(
			postEvent({ events: [userEvent] }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			events: [{ id: "event-2", sequence: 9 }],
		});
		expect(mocks.workflowData.appendSessionUserEvents).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			events: [userEvent],
		});
	});

	it("requires auth and validates event shape", async () => {
		await expectHttpStatus(
			Promise.resolve(GET(getEvent({ locals: { session: null } }) as never)),
			401,
		);
		await expectHttpStatus(
			Promise.resolve(POST(postEvent({ events: [] }) as never)),
			400,
		);
		await expectHttpStatus(
			Promise.resolve(
				POST(postEvent({ events: [{ type: "user.interrupt" }] }) as never),
			),
			400,
		);
	});
});
