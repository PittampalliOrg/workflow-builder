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
    status: "running" as const,
    phase: "running",
		progress: 40,
		error: null,
    input: { prompt: "ship it" },
		output: null,
    daprInstanceId: "sw-example-exec-exec-1",
    startedAt: new Date("2026-07-02T12:00:00.000Z"),
    completedAt: null,
	};
	const workflow = {
    id: "wf-1",
    name: "Example workflow",
    daprOrchestratorUrl: "http://workflow-orchestrator.test",
    engineType: "serverless-workflow",
	};
	const runtimeStatus = {
    runtimeStatus: "COMPLETED",
    phase: "complete",
		progress: 100,
    outputs: { result: "ok" },
	};
	const workflowData = {
    getExecutionById: vi.fn(
      async (): Promise<typeof execution | null> => execution,
    ),
    getScopedExecutionById: vi.fn(
      async (): Promise<typeof execution | null> => execution,
    ),
		getWorkflowByRef: vi.fn(async () => workflow),
    getScopedWorkflowById: vi.fn(async () => workflow),
    updateExecutionReadModel: vi.fn(async () => undefined),
	};
  const internalWorkflowPrincipal = { authorize: vi.fn() };
	const validateInternalOrPreviewControlRead = vi.fn(() => true);
  const validateInternalToken = vi.fn(() => false);
  const resolveInternalWorkflowPrincipal = vi.fn(async () => ({
    ok: true as const,
    principal: {
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      scopes: [],
    },
  }));
	const daprFetch = vi.fn(async () =>
		Response.json(runtimeStatus, {
      status: 200,
    }),
	);
	return {
		daprFetch,
		execution,
		runtimeStatus,
    resolveInternalWorkflowPrincipal,
		validateInternalOrPreviewControlRead,
    validateInternalToken,
		workflow,
    workflowData,
    internalWorkflowPrincipal,
	};
});

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: mocks.workflowData,
    internalWorkflowPrincipal: mocks.internalWorkflowPrincipal,
  }),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalOrPreviewControlRead:
    mocks.validateInternalOrPreviewControlRead,
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("../../../../../workflow-mcp-principal", () => ({
  resolveInternalWorkflowPrincipal: mocks.resolveInternalWorkflowPrincipal,
}));

vi.mock("$lib/server/dapr-client", () => ({
	daprFetch: mocks.daprFetch,
  getOrchestratorUrl: () => "http://fallback-orchestrator.test",
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
    request: new Request(
      "http://localhost/api/internal/agent/workflows/executions/exec-1/status",
      {
        headers: { "X-Preview-Control-Capability": "d".repeat(64) },
      },
    ),
    params: { executionId: "exec-1" },
    ...overrides,
	};
}

function internalEvent() {
  return event({
    request: new Request(
      "http://localhost/api/internal/agent/workflows/executions/exec-1/status",
      {
        headers: {
          "X-Internal-Token": "internal-token",
          "X-Wfb-Session-Id": "session-1",
        },
      },
    ),
  });
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("internal agent workflow execution status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalOrPreviewControlRead.mockReturnValue(true);
    mocks.validateInternalToken.mockReturnValue(false);
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
    mocks.workflowData.getScopedExecutionById.mockResolvedValue(
      mocks.execution,
    );
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
    mocks.workflowData.getScopedWorkflowById.mockResolvedValue(mocks.workflow);
		mocks.workflowData.updateExecutionReadModel.mockResolvedValue(undefined);
    mocks.resolveInternalWorkflowPrincipal.mockResolvedValue({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "session-1",
        scopes: [],
      },
    });
    mocks.daprFetch.mockResolvedValue(
      Response.json(mocks.runtimeStatus, { status: 200 }),
    );
	});

  it("keeps execution status reads behind workflow-data application services", () => {
		const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
		);

    expect(source).toContain("workflowData.getExecutionById");
    expect(source).toContain("workflowData.getScopedExecutionById");
    expect(source).toContain("workflowData.getWorkflowByRef");
    expect(source).toContain("workflowData.getScopedWorkflowById");
    expect(source).toContain("workflowData.updateExecutionReadModel");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("$lib/server/db/schema");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("workflowExecutions");
	});

  it("rejects a missing or mismatched preview read capability before data access", async () => {
		mocks.validateInternalOrPreviewControlRead.mockReturnValueOnce(false);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 401);
		expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getScopedExecutionById).not.toHaveBeenCalled();
	});

  it("rejects an internal caller when the execution is outside its principal project", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(true);
    mocks.workflowData.getScopedExecutionById.mockResolvedValueOnce(null);

    await expectHttpStatus(Promise.resolve(GET(internalEvent() as never)), 404);

    expect(mocks.resolveInternalWorkflowPrincipal).toHaveBeenCalledWith(
      expect.any(Request),
      mocks.internalWorkflowPrincipal,
      {
        requiredScope: "workflow:read",
        legacyResource: {
          kind: "workflow_execution",
          id: "exec-1",
        },
      },
    );
    expect(mocks.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
    expect(mocks.workflowData.getScopedWorkflowById).not.toHaveBeenCalled();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("rejects an internal caller without a valid workflow principal before data access", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(true);
    mocks.resolveInternalWorkflowPrincipal.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Session context is no longer active",
    } as never);

    await expectHttpStatus(Promise.resolve(GET(internalEvent() as never)), 403);

    expect(mocks.workflowData.getScopedExecutionById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getScopedWorkflowById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
    expect(mocks.daprFetch).not.toHaveBeenCalled();
  });

  it("uses principal-scoped execution and workflow lookups for an internal caller", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(true);

    const response = (await GET(internalEvent() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(mocks.workflowData.getScopedWorkflowById).toHaveBeenCalledWith({
      workflowId: "wf-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
    expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
  });

  it("returns 404 when the execution is missing", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce(null);

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.getWorkflowByRef).not.toHaveBeenCalled();
		expect(mocks.daprFetch).not.toHaveBeenCalled();
		expect(mocks.workflowData.updateExecutionReadModel).not.toHaveBeenCalled();
	});

  it("syncs completed runtime status to the execution read model", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
      status: "success",
			execution: {
        id: "exec-1",
        workflowId: "wf-1",
        status: "success",
				workflow: {
          id: "wf-1",
          name: "Example workflow",
        },
			},
      runtime: mocks.runtimeStatus,
		});
    expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
      workflowId: "wf-1",
      lookup: "id",
		});
		expect(mocks.daprFetch).toHaveBeenCalledWith(
      "http://workflow-orchestrator.test/api/v2/workflows/sw-example-exec-exec-1/status",
		);
    expect(mocks.workflowData.updateExecutionReadModel).toHaveBeenCalledWith(
      "exec-1",
      {
        status: "success",
        phase: "complete",
			progress: 100,
        output: { result: "ok" },
			error: null,
        completedAt: expect.any(Date),
      },
    );
	});
});
