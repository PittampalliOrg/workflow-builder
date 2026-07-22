import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	ApplicationWorkflowExecutionReadModelService,
	mapRuntimeStatus,
	resolveExecutionStatus,
	resolveExecutionStatusSnapshot,
} from "$lib/server/application/workflow-execution-read-model";
import type {
	WorkflowDataService,
	WorkflowExecutionRecord,
	WorkflowRuntimeStatusPort,
} from "$lib/server/application/ports";
import { LITE_WORKFLOW_NOT_EXECUTED_MESSAGE } from "$lib/server/application/lite-profile";

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
	compareAndSetReadModel?: ReturnType<typeof vi.fn>;
}) {
	const executions = [...(args?.executions ?? [execution()])];
	const listRecentEvents = args?.listRecentEvents ?? vi.fn(async () => []);
	const compareAndSetReadModel =
		args?.compareAndSetReadModel ??
		vi.fn(async ({ patch }) => execution(patch as Partial<WorkflowExecutionRecord>));
	const workflowData = {
		assertExecutionReadModelReady: vi.fn(async () => undefined),
		getExecutionById: vi.fn(async () => executions.shift() ?? executions.at(-1) ?? null),
		compareAndSetExecutionReadModel: compareAndSetReadModel,
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
		| "compareAndSetExecutionReadModel"
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

	it("resolves the explicit persisted/runtime status matrix", () => {
		const runtimeStatuses = [
			null,
			"UNKNOWN",
			"STALLED",
			"PENDING",
			"RUNNING",
			"SUSPENDED",
			"COMPLETED",
			"FAILED",
			"TERMINATED",
			"CANCELED",
		] as const;
		const matrix = {
			pending: [
				"pending",
				"pending",
				"pending",
				"pending",
				"running",
				"running",
				"success",
				"error",
				"cancelled",
				"cancelled",
			],
			running: [
				"running",
				"running",
				"running",
				"pending",
				"running",
				"running",
				"success",
				"error",
				"cancelled",
				"cancelled",
			],
			success: [
				"success",
				"success",
				"success",
				"success",
				"success",
				"success",
				"success",
				"error",
				"cancelled",
				"cancelled",
			],
			error: [
				"error",
				"error",
				"error",
				"error",
				"error",
				"error",
				"error",
				"error",
				"cancelled",
				"cancelled",
			],
			cancelled: [
				"cancelled",
				"cancelled",
				"cancelled",
				"cancelled",
				"cancelled",
				"cancelled",
				"cancelled",
				"error",
				"cancelled",
				"cancelled",
			],
		} as const;

		for (const [persistedStatus, expectedStatuses] of Object.entries(matrix)) {
			for (const [index, runtimeStatus] of runtimeStatuses.entries()) {
				expect(
					resolveExecutionStatus(
						runtimeStatus,
						persistedStatus as keyof typeof matrix,
					),
				).toBe(expectedStatuses[index]);
			}
		}
		expect(resolveExecutionStatus("  failed  ", "success")).toBe("error");
	});

	it("builds one coherent snapshot for a first terminal runtime observation", () => {
		const observedAt = new Date("2026-07-03T00:01:00.000Z");
		const persisted = {
			status: "running" as const,
			phase: "running",
			progress: 40,
			output: null,
			error: "stale transient error",
			completedAt: null,
		};

		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted,
			runtime: {
				runtimeStatus: "COMPLETED",
				phase: null,
				progress: null,
				outputs: { result: "ok" },
				error: null,
				completedAt: null,
			},
			observedAt,
		});

		expect(snapshot).toEqual({
			status: "success",
			phase: "completed",
			progress: 100,
			output: { result: "ok" },
			error: null,
			completedAt: observedAt,
		});
		expect(patch).toEqual(snapshot);
	});

	it("keeps a persisted script failure snapshot intact for runtime completion", () => {
		const persisted = {
			status: "error" as const,
			phase: "failed",
			progress: 100,
			output: { success: false },
			error: "agent budget exhausted",
			completedAt: new Date("2026-07-03T00:01:00.000Z"),
		};

		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted,
			runtime: {
				runtimeStatus: "COMPLETED",
				phase: "complete",
				progress: 100,
				outputs: { success: true },
				error: null,
				completedAt: "2026-07-03T00:02:00.000Z",
			},
			observedAt: new Date("2026-07-03T00:03:00.000Z"),
		});

		expect(snapshot).toEqual(persisted);
		expect(patch).toBeNull();
	});

	it.each([
		["success", "RUNNING"],
		["success", "COMPLETED"],
		["error", "FAILED"],
		["error", "COMPLETED"],
		["cancelled", "CANCELED"],
		["cancelled", "RUNNING"],
	] as const)("freezes exact %s companion fields for runtime %s", (status, runtimeStatus) => {
		const persisted = {
			status,
			phase: "persisted-phase",
			progress: 73,
			output: { source: "persisted" },
			error: "persisted-error",
			completedAt: new Date("2026-07-03T00:01:00.000Z"),
		};

		const resolved = resolveExecutionStatusSnapshot({
			persisted,
			runtime: {
				runtimeStatus,
				phase: "runtime-phase",
				progress: 100,
				outputs: { source: "runtime" },
				error: "runtime-error",
				completedAt: "2026-07-03T00:02:00.000Z",
			},
			observedAt: new Date("2026-07-03T00:03:00.000Z"),
		});

		expect(resolved).toEqual({ snapshot: persisted, patch: null });
	});

	it("uses a hard runtime failure snapshot when it changes a terminal result", () => {
		const observedAt = new Date("2026-07-03T00:03:00.000Z");
		const persistedCompletedAt = new Date("2026-07-03T00:01:00.000Z");
		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted: {
				status: "success",
				phase: "completed",
				progress: 100,
				output: { result: "stale success" },
				error: null,
				completedAt: persistedCompletedAt,
			},
			runtime: {
				runtimeStatus: "FAILED",
				phase: "running",
				progress: 40,
				outputs: { result: "failed" },
				error: "runtime failed",
				completedAt: null,
			},
			observedAt,
		});

		expect(snapshot).toEqual({
			status: "error",
			phase: "failed",
			progress: 100,
			output: { result: "stale success" },
			error: "runtime failed",
			completedAt: persistedCompletedAt,
		});
		expect(patch).toEqual(snapshot);
	});

	it("canonicalizes an error-to-cancelled correction with persisted-first cancellation data", () => {
		const persistedCompletedAt = new Date("2026-07-03T00:01:00.000Z");
		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted: {
				status: "error",
				phase: "failed",
				progress: 100,
				output: { result: "partial" },
				error: "persisted stop reason",
				completedAt: persistedCompletedAt,
			},
			runtime: {
				runtimeStatus: "CANCELED",
				phase: "runtime-cancel",
				progress: 20,
				outputs: { result: "runtime" },
				error: "runtime cancellation",
				completedAt: "2026-07-03T00:02:00.000Z",
			},
			observedAt: new Date("2026-07-03T00:03:00.000Z"),
		});

		expect(snapshot).toEqual({
			status: "cancelled",
			phase: "cancelled",
			progress: 100,
			output: { result: "partial" },
			error: "persisted stop reason",
			completedAt: persistedCompletedAt,
		});
		expect(patch).toEqual(snapshot);
	});

	it("canonicalizes a cancelled-to-error correction with the runtime failure", () => {
		const persistedCompletedAt = new Date("2026-07-03T00:01:00.000Z");
		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted: {
				status: "cancelled",
				phase: "cancelled",
				progress: 100,
				output: { result: "partial" },
				error: "persisted cancellation",
				completedAt: persistedCompletedAt,
			},
			runtime: {
				runtimeStatus: "FAILED",
				phase: "runtime-failure",
				progress: 40,
				outputs: { result: "runtime" },
				error: "runtime failed",
				completedAt: "2026-07-03T00:02:00.000Z",
			},
			observedAt: new Date("2026-07-03T00:03:00.000Z"),
		});

		expect(snapshot).toEqual({
			status: "error",
			phase: "failed",
			progress: 100,
			output: { result: "partial" },
			error: "runtime failed",
			completedAt: persistedCompletedAt,
		});
		expect(patch).toEqual(snapshot);
	});

	it("keeps lifecycle-acknowledged cancellation authoritative over runtime failure", () => {
		const persistedCompletedAt = new Date("2026-07-03T00:01:00.000Z");
		const { snapshot, patch } = resolveExecutionStatusSnapshot({
			persisted: {
				status: "cancelled",
				phase: "cancelled",
				progress: 100,
				output: {
					success: false,
					phase: "cancelled",
					workflowOutput: null,
				},
				error: "Stopped by user",
				completedAt: persistedCompletedAt,
				stopReason: "Stopped by user",
			},
			runtime: {
				runtimeStatus: "FAILED",
				phase: "runtime-failure",
				progress: 40,
				outputs: { completedNaturally: true },
				error: "runtime failed after cancellation",
				completedAt: "2026-07-03T00:02:00.000Z",
			},
			observedAt: new Date("2026-07-03T00:03:00.000Z"),
		});

		expect(snapshot).toEqual({
			status: "cancelled",
			phase: "cancelled",
			progress: 100,
			output: {
				success: false,
				phase: "cancelled",
				workflowOutput: null,
			},
			error: "Stopped by user",
			completedAt: persistedCompletedAt,
		});
		expect(patch).toBeNull();
	});

	it("refreshes running executions and uses the row returned by persistence", async () => {
		const compareAndSetReadModel = vi.fn(async ({ patch }) =>
			execution(patch as Partial<WorkflowExecutionRecord>),
		);
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
			executions: [execution()],
			runtime: runtimeStatus,
			compareAndSetReadModel,
		});

		const model = await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: true,
		});

		expect(runtimeStatus.getWorkflowStatus).toHaveBeenCalledWith("sw-exec-1");
		expect(compareAndSetReadModel).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				expectedStatus: "running",
				patch: expect.objectContaining({
					status: "success",
					phase: "completed",
					progress: 100,
					primaryTraceId: "trace-runtime",
				}),
			}),
		);
		expect(workflowData.getExecutionById).toHaveBeenCalledTimes(1);
		expect(model?.status).toBe("success");
		expect(model?.traceId).toBe("trace-runtime");
	});

	it("uses the exact terminal row that wins a refresh race", async () => {
		const winner = execution({
			status: "error",
			phase: "failed",
			progress: 100,
			output: { success: false },
			error: "agent budget exhausted",
			completedAt: new Date("2026-07-03T00:00:45.000Z"),
		});
		const compareAndSetReadModel = vi.fn(async () => winner);
		const runtimeStatus = {
			getWorkflowStatus: vi.fn(async () => ({
				runtimeStatus: "COMPLETED",
				phase: "completed",
				progress: 100,
				currentNodeId: "agent",
				currentNodeName: "Agent",
				traceId: null,
				outputs: { success: true },
				error: null,
				completedAt: "2026-07-03T00:01:00.000Z",
			})),
		} satisfies WorkflowRuntimeStatusPort;
		const { service: readModel, workflowData } = service({
			executions: [execution()],
			runtime: runtimeStatus,
			compareAndSetReadModel,
		});

		const model = await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: false,
		});

		expect(model).toMatchObject({
			status: "error",
			phase: "failed",
			progress: 100,
			output: { success: false },
			error: "agent budget exhausted",
			completedAt: "2026-07-03T00:00:45.000Z",
		});
		expect(compareAndSetReadModel).toHaveBeenCalledTimes(1);
		expect(workflowData.getExecutionById).toHaveBeenCalledTimes(1);
	});

	it("surfaces a not-executed-in-lite state instead of polling a lite instance", async () => {
		const compareAndSetReadModel = vi.fn(async ({ patch }) =>
			execution({
				daprInstanceId: "lite-abc",
				...(patch as Partial<WorkflowExecutionRecord>),
			}),
		);
		const runtimeStatus = {
			getWorkflowStatus: vi.fn(async () => null),
		} satisfies WorkflowRuntimeStatusPort;
		const { service: readModel } = service({
			executions: [execution({ daprInstanceId: "lite-abc", status: "running" })],
			runtime: runtimeStatus,
			compareAndSetReadModel,
		});

		const model = await readModel.loadExecutionReadModel({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: false,
		});

		expect(runtimeStatus.getWorkflowStatus).not.toHaveBeenCalled();
		expect(compareAndSetReadModel).toHaveBeenCalledWith(
			expect.objectContaining({
				executionId: "exec-1",
				expectedStatus: "running",
				patch: expect.objectContaining({
					status: "error",
					phase: "failed",
					progress: 100,
					error: LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
				}),
			}),
		);
		expect(model?.status).toBe("error");
		expect(model?.error).toBe(LITE_WORKFLOW_NOT_EXECUTED_MESSAGE);
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
