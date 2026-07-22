import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		ingestSessionEvent: vi.fn(async () => ({
			event: {
				id: "event-1",
				sessionId: "session-1",
				sequence: 1,
				type: "agent.tool_result",
				data: { ok: true },
				processedAt: null,
				sourceEventId: "source-1",
				producerId: "runtime-1",
				producerEpoch: "epoch-1",
				createdAt: "2026-07-02T00:00:00.000Z",
				timestamp: "2026-07-02T00:00:00.000Z",
			},
			cleanupSessionSandbox: false,
		})),
		};
		const validateInternalToken = vi.fn(() => true);
		const cleanupSessionSandbox = vi.fn(async () => undefined);
		const sessionRuntimeHostCleanup = {
			requestReap: vi.fn(),
			reapPending: vi.fn(async () => ({
				scanned: 1,
				acknowledged: ["session-1"],
				failed: [],
				dryRun: false,
			})),
		};
		return {
			cleanupSessionSandbox,
			sessionRuntimeHostCleanup,
			validateInternalToken,
			workflowData,
		};
	});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		sessionRuntimeHostCleanup: mocks.sessionRuntimeHostCleanup,
	}),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/sandboxes/provision", () => ({
	cleanupSessionSandbox: mocks.cleanupSessionSandbox,
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		params: { id: "session-1" },
		request: new Request(
			"http://localhost/api/internal/sessions/session-1/events/ingest",
			{
				method: "POST",
				body: typeof body === "string" ? body : JSON.stringify(body),
				headers: { "Content-Type": "application/json" },
			},
		),
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

describe("internal session event ingest route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.ingestSessionEvent.mockResolvedValue({
			event: {
				id: "event-1",
				sessionId: "session-1",
				sequence: 1,
				type: "agent.tool_result",
				data: { ok: true },
				processedAt: null,
				sourceEventId: "source-1",
				producerId: "runtime-1",
				producerEpoch: "epoch-1",
				createdAt: "2026-07-02T00:00:00.000Z",
				timestamp: "2026-07-02T00:00:00.000Z",
			},
			cleanupSessionSandbox: false,
		});
	});

	it("keeps event persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.ingestSessionEvent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("appendEvent");
		expect(source).not.toContain("updateSessionStatus");
		expect(source).not.toContain("persistCodeCheckpointFromAgentEvent");
		expect(source).not.toContain("recordEvaluationArtifact");
	});

	it("requires an internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);

		await expectHttpStatus(
			Promise.resolve(POST(event({ type: "agent.tool_result" }) as never)),
			401,
		);
		expect(mocks.workflowData.ingestSessionEvent).not.toHaveBeenCalled();
	});

	it("validates the event type before ingesting", async () => {
		await expectHttpStatus(Promise.resolve(POST(event({ data: {} }) as never)), 400);
		expect(mocks.workflowData.ingestSessionEvent).not.toHaveBeenCalled();
	});

	it("delegates normalized envelopes to workflow-data", async () => {
		const response = (await POST(
			event({
				type: "agent.tool_result",
				data: { ok: true },
				sourceEventId: "source-1",
				producerId: "runtime-1",
				producerEpoch: "epoch-1",
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			event: expect.objectContaining({
				id: "event-1",
				type: "agent.tool_result",
			}),
		});
		expect(mocks.workflowData.ingestSessionEvent).toHaveBeenCalledWith({
			sessionId: "session-1",
			type: "agent.tool_result",
			data: { ok: true },
			sourceEventId: "source-1",
			producerId: "runtime-1",
			producerEpoch: "epoch-1",
		});
		expect(mocks.cleanupSessionSandbox).not.toHaveBeenCalled();
	});

	it("eagerly reaps a naturally completed Pydantic host", async () => {
		mocks.workflowData.ingestSessionEvent.mockResolvedValueOnce({
			event: {
				id: "event-terminated",
				sessionId: "session-1",
				sequence: 2,
				type: "session.status_terminated",
				data: { ok: false },
				processedAt: null,
				sourceEventId: "source-terminated",
				producerId: "runtime-1",
				producerEpoch: "epoch-1",
				createdAt: "2026-07-02T00:00:00.000Z",
				timestamp: "2026-07-02T00:00:00.000Z",
			},
			cleanupSessionSandbox: true,
		});

		const response = (await POST(
			event({ type: "session.status_terminated", data: {} }) as never,
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.cleanupSessionSandbox).toHaveBeenCalledWith("session-1");
		expect(mocks.sessionRuntimeHostCleanup.requestReap).toHaveBeenCalledOnce();
	});
});
