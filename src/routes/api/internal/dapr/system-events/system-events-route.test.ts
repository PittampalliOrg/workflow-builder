import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		findSessionIdByDaprInstanceId: vi.fn(async (): Promise<string | null> => "session-1"),
		appendSessionEvent: vi.fn(async () => ({
			id: "event-1",
			sessionId: "session-1",
			sequence: 1,
			type: "workflow.state",
			data: {},
			processedAt: null,
			sourceEventId: null,
			producerId: null,
			producerEpoch: null,
			createdAt: "2026-07-02T00:00:00.000Z",
			timestamp: "2026-07-02T00:00:00.000Z",
		})),
	};
	const push = vi.fn();
	return { push, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/dapr-event-stream", () => ({
	daprEventStream: { push: mocks.push },
}));

import { POST } from "./+server";

function event(body: unknown) {
	return {
		request: new Request("http://localhost/api/internal/dapr/system-events", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}),
	};
}

describe("internal Dapr system-events route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.findSessionIdByDaprInstanceId.mockResolvedValue("session-1");
	});

	it("keeps workflow-state persistence behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.findSessionIdByDaprInstanceId");
		expect(source).toContain("workflowData.appendSessionEvent");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("appendEvent");
	});

	it("acks malformed events without touching persistence", async () => {
		const response = (await POST(event("{") as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
		expect(mocks.push).not.toHaveBeenCalled();
		expect(mocks.workflowData.findSessionIdByDaprInstanceId).not.toHaveBeenCalled();
		expect(mocks.workflowData.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("mirrors workflow-state events to the session timeline", async () => {
		const data = { instance_id: "inst-1", type: "WorkflowCompleted" };
		const response = (await POST(
			event({
				topic: "workflow-state-events",
				id: "cloudevent-1",
				type: "com.dapr.workflow.state",
				source: "dapr",
				data,
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
		expect(mocks.push).toHaveBeenCalledWith(
			"workflow-state-events",
			"com.dapr.workflow.state",
			"dapr",
			data,
		);
		expect(mocks.workflowData.findSessionIdByDaprInstanceId).toHaveBeenCalledWith(
			"inst-1",
		);
		expect(mocks.workflowData.appendSessionEvent).toHaveBeenCalledWith(
			"session-1",
			{
				type: "workflow.state",
				data,
				sourceEventId: "dapr-wf-state:inst-1:cloudevent-1",
			},
		);
	});

	it("acks workflow-state events when no session matches", async () => {
		mocks.workflowData.findSessionIdByDaprInstanceId.mockResolvedValueOnce(null);

		const response = (await POST(
			event({
				topic: "workflow-state-events",
				data: { instanceId: "inst-missing" },
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ status: "SUCCESS" });
		expect(mocks.workflowData.appendSessionEvent).not.toHaveBeenCalled();
	});
});
