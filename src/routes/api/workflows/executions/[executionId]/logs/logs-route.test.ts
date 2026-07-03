import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const logsBody = {
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
		output: { ok: true },
	};
	const workflowExecutionLogs = {
		getLogs: vi.fn<() => Promise<unknown>>(async () => ({
			status: "ok",
			body: logsBody,
		})),
	};
	return { logsBody, workflowExecutionLogs };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowExecutionLogs: mocks.workflowExecutionLogs }),
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
		mocks.workflowExecutionLogs.getLogs.mockResolvedValue({
			status: "ok",
			body: mocks.logsBody,
		});
	});

	it("keeps the route behind the workflow execution logs application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("workflowExecutionLogs.getLogs");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/otel/clickhouse");
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
		expect(mocks.workflowExecutionLogs.getLogs).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowExecutionLogs.getLogs.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});
