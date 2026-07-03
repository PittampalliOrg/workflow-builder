import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	ApplicationWorkflowExecutionReadModelService,
	mapRuntimeStatus,
} from "$lib/server/application/workflow-execution-read-model";
import type {
	WorkflowDataService,
	WorkflowExecutionRecord,
	WorkflowRuntimeStatusPort,
} from "$lib/server/application/ports";

function execution(overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		input: { prompt: "go" },
		output: null,
		executionIrVersion: null,
		executionIr: null,
		error: null,
		daprInstanceId: "sw-exec-1",
		phase: "running",
		progress: 20,
		currentNodeId: "agent",
		currentNodeName: "Agent",
		primaryTraceId: null,
		workflowSessionId: "session-1",
		mlflowExperimentId: null,
		mlflowRunId: null,
		summaryOutput: { summary: true },
		errorStackTrace: null,
		rerunOfExecutionId: null,
		rerunSourceInstanceId: null,
		resumeFromNode: null,
		triggerSource: null,
		rerunFromEventId: null,
		startedAt: new Date("2026-07-03T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		stopRequestedAt: null,
		stopReason: null,
		...overrides,
	};
}

function service(args?: {
	executions?: WorkflowExecutionRecord[];
	runtime?: WorkflowRuntimeStatusPort;
	listRecentEvents?: ReturnType<typeof vi.fn>;
	updateReadModel?: ReturnType<typeof vi.fn>;
}) {
	const executions = [...(args?.executions ?? [execution()])];
	const listRecentEvents = args?.listRecentEvents ?? vi.fn(async () => []);
	const updateReadModel = args?.updateReadModel ?? vi.fn(async () => undefined);
	const workflowData = {
		assertExecutionReadModelReady: vi.fn(async () => undefined),
		getExecutionById: vi.fn(async () => executions.shift() ?? executions.at(-1) ?? null),
		updateExecutionReadModel: updateReadModel,
		listExecutionLogs: vi.fn(async () => [
			{
				id: "log-1",
				executionId: "exec-1",
				nodeId: "agent",
				nodeName: "Agent",
				nodeType: "action",
				activityName: "durable/run",
				status: "running" as const,
				input: { prompt: "go" },
				output: { partial: true },
				error: null,
				startedAt: new Date("2026-07-03T00:00:01.000Z"),
				completedAt: null,
				duration: null,
				timestamp: new Date("2026-07-03T00:00:01.000Z"),
				credentialFetchMs: null,
				routingMs: null,
				coldStartMs: null,
				executionMs: null,
				routedTo: null,
				wasColdStart: null,
			},
		]),
		listRecentExecutionAgentEvents: listRecentEvents,
		listWorkflowAgentRunsByExecutionId: vi.fn(async () => []),
		listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => []),
		listWorkflowBrowserArtifactsByExecutionId: vi.fn(async () => []),
		listWorkflowArtifactsByExecutionId: vi.fn(async () => []),
	} as unknown as Pick<
		WorkflowDataService,
		| "assertExecutionReadModelReady"
		| "getExecutionById"
		| "updateExecutionReadModel"
		| "listExecutionLogs"
		| "listRecentExecutionAgentEvents"
		| "listWorkflowAgentRunsByExecutionId"
		| "listWorkflowWorkspaceSessionsByExecutionId"
		| "listWorkflowBrowserArtifactsByExecutionId"
		| "listWorkflowArtifactsByExecutionId"
	>;
	const runtimeStatus =
		args?.runtime ??
		({
			getWorkflowStatus: vi.fn(async () => null),
		} satisfies WorkflowRuntimeStatusPort);
	return {
		workflowData,
		runtimeStatus,
		service: new ApplicationWorkflowExecutionReadModelService({
			workflowData,
			runtimeStatus,
			traceExtractor: (value) =>
				value && typeof value === "object" && "traceId" in value
					? [String((value as { traceId: unknown }).traceId)]
					: [],
		}),
	};
}

describe("ApplicationWorkflowExecutionReadModelService", () => {
	it("keeps infrastructure imports out of the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "workflow-execution-read-model.ts"),
			"utf8",
		);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("daprFetch");
	});

	it("maps runtime statuses consistently", () => {
		expect(mapRuntimeStatus("COMPLETED", "running")).toBe("success");
		expect(mapRuntimeStatus("FAILED", "running")).toBe("error");
		expect(mapRuntimeStatus("TERMINATED", "running")).toBe("cancelled");
		expect(mapRuntimeStatus("CANCELED", "running")).toBe("cancelled");
		expect(mapRuntimeStatus("PENDING", "running")).toBe("pending");
		expect(mapRuntimeStatus("RUNNING", "pending")).toBe("running");
		expect(mapRuntimeStatus("SUSPENDED", "pending")).toBe("running");
		expect(mapRuntimeStatus("UNKNOWN", "pending")).toBe("pending");
	});

	it("refreshes running executions through the runtime port, persists, then rereads", async () => {
		const updateReadModel = vi.fn(async () => undefined);
		const runtimeStatus = {
			getWorkflowStatus: vi.fn(async () => ({
				runtimeStatus: "COMPLETED",
				phase: "completed",
				progress: 100,
				currentNodeId: "agent",
				currentNodeName: "Agent",
				traceId: "trace-runtime",
				outputs: { content: "done" },
				error: null,
				completedAt: "2026-07-03T00:01:00.000Z",
			})),
		} satisfies WorkflowRuntimeStatusPort;
		const { service: readModel, workflowData } = service({
			executions: [
				execution(),
				execution({
					status: "success",
					phase: "completed",
					progress: 100,
					primaryTraceId: "trace-runtime",
					output: { content: "done" },
					completedAt: new Date("2026-07-03T00:01:00.000Z"),
				}),
			],
			runtime: runtimeStatus,
			updateReadModel,
		});

		const model = await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: true,
		});

		expect(runtimeStatus.getWorkflowStatus).toHaveBeenCalledWith("sw-exec-1");
		expect(updateReadModel).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({
				status: "success",
				phase: "completed",
				progress: 100,
				primaryTraceId: "trace-runtime",
			}),
		);
		expect(workflowData.getExecutionById).toHaveBeenCalledTimes(2);
		expect(model?.status).toBe("success");
		expect(model?.traceId).toBe("trace-runtime");
	});

	it("loads recent agent events for trace harvesting when timeline events are hidden", async () => {
		const listRecentEvents = vi.fn(async () => []);
		const { service: readModel } = service({ listRecentEvents });

		await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: false,
			includeAgentEvents: false,
		});

		expect(listRecentEvents).toHaveBeenCalledTimes(1);
		expect(listRecentEvents).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 200,
		});
	});

	it("compacts non-terminal snapshots but preserves terminal outputs", async () => {
		const { service: readModel } = service();
		const model = await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: false,
			includeAgentEvents: false,
		});
		expect(model).not.toBeNull();

		const compactRunning = readModel.serializeExecutionReadModel(model, {
			compact: true,
			includeAgentEvents: false,
		});
		expect(compactRunning.output).toEqual({ summary: true });
		expect((compactRunning.steps as Array<{ input: unknown; output: unknown }>)[0]).toMatchObject({
			input: null,
			output: null,
		});

		const compactTerminal = readModel.serializeExecutionReadModel(
			{ ...model!, status: "success", output: { content: "done" } },
			{ compact: true, includeAgentEvents: false },
		);
		expect(compactTerminal.output).toEqual({ content: "done" });
	});
});
