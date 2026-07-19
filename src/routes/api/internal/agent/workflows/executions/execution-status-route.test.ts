import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	validateInternalOrPreviewControlRead: vi.fn(),
  validateInternalToken: vi.fn(),
	workflowData: {
		getExecutionById: vi.fn(),
    getScopedExecutionById: vi.fn(),
		getWorkflowByRef: vi.fn(),
    getScopedWorkflowById: vi.fn(),
		compareAndSetExecutionReadModel: vi.fn(),
	},
	daprFetch: vi.fn(),
	getOrchestratorUrl: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalOrPreviewControlRead:
    mocks.validateInternalOrPreviewControlRead,
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("../../../workflow-mcp-principal", () => ({
  resolveInternalWorkflowPrincipal: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
	}),
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
	getOrchestratorUrl: mocks.getOrchestratorUrl,
}));

import { GET } from "./[executionId]/status/+server";

function makeExecution(overrides: Record<string, unknown> = {}) {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		status: "running",
		phase: "Execute",
		progress: 50,
		error: null,
		input: null,
		output: null,
		daprInstanceId: "dapr-exec-1",
		startedAt: new Date("2026-07-17T00:00:00Z"),
		completedAt: null,
		...overrides,
	};
}

function callGet(executionId = "exec-1") {
	return GET({
		request: new Request("http://localhost"),
		params: { executionId },
	} as never) as Promise<Response>;
}

describe("internal agent workflow execution status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalOrPreviewControlRead.mockReturnValue(true);
    mocks.validateInternalToken.mockReturnValue(false);
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(null);
		mocks.workflowData.compareAndSetExecutionReadModel.mockImplementation(
			async (input: { patch: Record<string, unknown> }) => makeExecution(input.patch),
		);
		mocks.getOrchestratorUrl.mockReturnValue("http://orchestrator");
	});

	it("does NOT rewrite a terminal row when the runtime reports stale phase/progress", async () => {
		// Live-confirmed failure mode: dynamic-script engine leaves Dapr custom
		// status at {phase: "Finalize", progress: 0} forever after completion.
		mocks.workflowData.getExecutionById.mockResolvedValue(
			makeExecution({
				status: "success",
				phase: "completed",
				progress: 100,
				output: { result: "final" },
				completedAt: new Date("2026-07-17T00:05:00Z"),
			}),
		);
		mocks.daprFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				runtimeStatus: "RUNNING",
				phase: "Finalize",
				progress: 0,
				outputs: { result: "stale-runtime-output" },
			}),
		});

		const response = await callGet();
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.workflowData.compareAndSetExecutionReadModel).not.toHaveBeenCalled();
		expect(body.execution.output).toEqual({ result: "final" });
		expect(body.execution.progress).toBe(100);
	});

	it("skips the DB sync for every terminal status", async () => {
		for (const status of ["success", "error", "cancelled"]) {
			mocks.workflowData.compareAndSetExecutionReadModel.mockClear();
			mocks.workflowData.getExecutionById.mockResolvedValue(
				makeExecution({ status, phase: "completed", progress: 100 }),
			);
			mocks.daprFetch.mockResolvedValue({
				ok: true,
        json: async () => ({
          runtimeStatus: "RUNNING",
          phase: "Finalize",
          progress: 0,
        }),
			});

			const response = await callGet();

			expect(response.status).toBe(200);
      expect(
        mocks.workflowData.compareAndSetExecutionReadModel,
      ).not.toHaveBeenCalled();
		}
	});

	it("still syncs a running row when the runtime diverges", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValue(makeExecution());
		mocks.daprFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				runtimeStatus: "RUNNING",
				phase: "Finalize",
				progress: 90,
			}),
		});

		const response = await callGet();

		expect(response.status).toBe(200);
    expect(mocks.workflowData.compareAndSetExecutionReadModel).toHaveBeenCalledTimes(
      1,
    );
		expect(mocks.workflowData.compareAndSetExecutionReadModel).toHaveBeenCalledWith({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: expect.objectContaining({
				status: "running",
				phase: "Finalize",
				progress: 90,
			}),
		});
	});

	it("never lets runtime outputs replace an existing persisted output on a running row", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValue(
			makeExecution({ output: { result: "persisted" } }),
		);
		mocks.daprFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				runtimeStatus: "RUNNING",
				phase: "Finalize",
				progress: 90,
				outputs: { result: "runtime-overwrite" },
			}),
		});

		await callGet();

		expect(mocks.workflowData.compareAndSetExecutionReadModel).toHaveBeenCalledWith({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: expect.objectContaining({ output: { result: "persisted" } }),
		});
	});

	it("fills a null output from runtime outputs on a running row", async () => {
    mocks.workflowData.getExecutionById.mockResolvedValue(
      makeExecution({ output: null }),
    );
		mocks.daprFetch.mockResolvedValue({
			ok: true,
			json: async () => ({
				runtimeStatus: "RUNNING",
				phase: "Finalize",
				progress: 90,
				outputs: { result: "from-runtime" },
			}),
		});

		await callGet();

		expect(mocks.workflowData.compareAndSetExecutionReadModel).toHaveBeenCalledWith({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: expect.objectContaining({ output: { result: "from-runtime" } }),
		});
	});
});
