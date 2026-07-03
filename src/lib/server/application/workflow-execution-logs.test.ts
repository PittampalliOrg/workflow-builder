import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionLogsService } from "$lib/server/application/workflow-execution-logs";

describe("ApplicationWorkflowExecutionLogsService", () => {
	let workflowData: ConstructorParameters<
		typeof ApplicationWorkflowExecutionLogsService
	>[0]["workflowData"];
	let traceExtractor: ConstructorParameters<
		typeof ApplicationWorkflowExecutionLogsService
	>[0]["traceExtractor"];
	let service: ApplicationWorkflowExecutionLogsService;

	beforeEach(() => {
		workflowData = {
			getExecutionById: vi.fn(async () => execution() as never),
			getScopedExecutionById: vi.fn(async () => execution() as never),
			listExecutionLogs: vi.fn(async () => [persistedLog()] as never),
			listExecutionAgentEvents: vi.fn(async () => [agentEvent()] as never),
		};
		traceExtractor = vi.fn(() => ["trace-root", "trace-child"]);
		service = new ApplicationWorkflowExecutionLogsService({
			workflowData,
			traceExtractor,
		});
	});

	it("returns persisted node logs and session-backed agent events after scoped access", async () => {
		await expect(
			service.getLogs({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			body: {
				logs: [
					{
						stepName: "agent",
						label: "Agent",
						actionType: "durable/run",
						status: "success",
						input: { prompt: "ship it" },
						output: { ok: true },
						error: null,
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
						data: {
							name: "bash",
							input: { cmd: "pwd" },
							phase: "running",
							toolName: "bash",
							args: { cmd: "pwd" },
						},
						timestamp: "2026-01-01T00:00:03.000Z",
					},
				],
				traceId: "trace-root",
				traceIds: ["trace-root", "trace-child"],
				executionStatus: "running",
				input: { prompt: "ship it" },
				output: execution().output,
			},
		});
		expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowData.getExecutionById).not.toHaveBeenCalled();
		expect(workflowData.listExecutionLogs).toHaveBeenCalledWith("exec-1");
		expect(workflowData.listExecutionAgentEvents).toHaveBeenCalledWith("exec-1");
		expect(traceExtractor).toHaveBeenCalledWith(execution().output);
	});

	it("preserves the legacy no-session lookup path", async () => {
		await expect(service.getLogs({ executionId: "exec-1" })).resolves.toMatchObject({
			status: "ok",
		});
		expect(workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(workflowData.getScopedExecutionById).not.toHaveBeenCalled();
	});

	it("falls back to execution output logs when no persisted logs exist", async () => {
		vi.mocked(workflowData.listExecutionLogs).mockResolvedValueOnce([]);

		await expect(service.getLogs(scopedInput())).resolves.toMatchObject({
			status: "ok",
			body: {
				logs: [
					{
						stepName: "agent",
						label: "Agent",
						actionType: "durable/run",
						status: "success",
						input: null,
						output: { ok: true },
						error: null,
						durationMs: 42,
					},
				],
			},
		});
	});

	it("deduplicates steps and filters virtual trigger/state logs", async () => {
		vi.mocked(workflowData.listExecutionLogs).mockResolvedValueOnce([
			persistedLog({ id: "log-1", nodeId: "agent" }),
			persistedLog({ id: "log-duplicate", nodeId: "agent", nodeName: "Duplicate" }),
			persistedLog({ id: "log-trigger", nodeId: "trigger" }),
			persistedLog({ id: "log-state", nodeId: "state" }),
		] as never);

		await expect(service.getLogs(scopedInput())).resolves.toMatchObject({
			status: "ok",
			body: {
				logs: [
					{
						stepName: "agent",
						label: "Agent",
					},
				],
			},
		});
	});

	it("uses stashed internal event types and reverses llm content shape", async () => {
		vi.mocked(workflowData.listExecutionAgentEvents).mockResolvedValueOnce([
			agentEvent({
				type: "agent.message",
				data: {
					_internalType: "llm_complete",
					content: [
						{ type: "text", text: "hello " },
						{ type: "text", text: "world" },
					],
				},
			}),
		] as never);

		await expect(service.getLogs(scopedInput())).resolves.toMatchObject({
			status: "ok",
			body: {
				agentEvents: [
					{
						type: "llm_complete",
						data: {
							_internalType: "llm_complete",
							content: "hello world",
						},
					},
				],
			},
		});
	});

	it("hides missing or out-of-scope executions before loading logs", async () => {
		vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

		await expect(service.getLogs(scopedInput())).resolves.toEqual({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});
		expect(workflowData.listExecutionLogs).not.toHaveBeenCalled();
		expect(workflowData.listExecutionAgentEvents).not.toHaveBeenCalled();
	});
});

function scopedInput() {
	return {
		executionId: "exec-1",
		userId: "user-1",
		projectId: "project-1",
	};
}

function execution(overrides: Record<string, unknown> = {}) {
	return {
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
		...overrides,
	};
}

function persistedLog(overrides: Record<string, unknown> = {}) {
	return {
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
		...overrides,
	};
}

function agentEvent(overrides: Record<string, unknown> = {}) {
	return {
		id: 7,
		sessionId: "session-1",
		type: "agent.tool_use",
		sourceEventId: "source-1",
		data: { name: "bash", input: { cmd: "pwd" }, phase: "running" },
		createdAt: new Date("2026-01-01T00:00:03.000Z"),
		...overrides,
	};
}
