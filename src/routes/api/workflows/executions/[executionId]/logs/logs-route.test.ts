import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		input: { prompt: "ship it" },
		output: {
			traceId: "trace-root",
			outputs: {
				agent: {
					label: "Agent",
					actionType: "durable/run",
					data: { success: true, output: { ok: true }, duration_ms: 42 },
				},
			},
		},
	};
	const nodeLog = {
		id: "log-1",
		executionId: "exec-1",
		nodeId: "agent",
		nodeName: "Agent",
		nodeType: "action",
		activityName: "durable/run",
		status: "success" as const,
		input: { prompt: "ship it" },
		output: { ok: true },
		error: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: new Date("2026-01-01T00:00:02.000Z"),
		duration: "2000",
		timestamp: new Date("2026-01-01T00:00:00.000Z"),
		credentialFetchMs: null,
		routingMs: null,
		coldStartMs: null,
		executionMs: null,
		routedTo: null,
		wasColdStart: null,
	};
	const agentEvent = {
		id: 7,
		sessionId: "session-1",
		type: "agent.tool_use",
		sourceEventId: "source-1",
		data: { name: "bash", input: { cmd: "pwd" }, phase: "running" },
		createdAt: new Date("2026-01-01T00:00:03.000Z"),
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		listExecutionLogs: vi.fn(async () => [nodeLog]),
		listExecutionAgentEvents: vi.fn(async () => [agentEvent]),
	};
	return { execution, nodeLog, agentEvent, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/otel/clickhouse", () => ({
	extractExecutionTraceIds: vi.fn(() => ["trace-root", "trace-child"]),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
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

describe("workflow execution logs route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.listExecutionLogs.mockResolvedValue([mocks.nodeLog]);
		mocks.workflowData.listExecutionAgentEvents.mockResolvedValue([mocks.agentEvent]);
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns normalized node logs and session-backed agent events", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			logs: [
				{
					stepName: "agent",
					label: "Agent",
					actionType: "durable/run",
					status: "success",
					durationMs: 2000,
				},
			],
			agentEvents: [
				{
					id: 7,
					type: "tool_call_start",
					sourceEventId: "source-1",
					workflowAgentRunId: "session-1",
					daprInstanceId: "session-1",
					sessionId: "session-1",
					toolName: "bash",
					phase: "running",
					timestamp: "2026-01-01T00:00:03.000Z",
				},
			],
			traceId: "trace-root",
			traceIds: ["trace-root", "trace-child"],
			executionStatus: "running",
			input: { prompt: "ship it" },
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.listExecutionLogs).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.listExecutionAgentEvents).toHaveBeenCalledWith("exec-1");
	});

	it("falls back to execution output step logs when no persisted logs exist", async () => {
		mocks.workflowData.listExecutionLogs.mockResolvedValueOnce([]);

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			logs: [
				{
					stepName: "agent",
					label: "Agent",
					actionType: "durable/run",
					status: "success",
					durationMs: 42,
				},
			],
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listExecutionLogs).not.toHaveBeenCalled();
		expect(mocks.workflowData.listExecutionAgentEvents).not.toHaveBeenCalled();
	});
});
