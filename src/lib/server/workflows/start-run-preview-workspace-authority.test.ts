import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApplicationAdapters: vi.fn(),
  validateWithEvaluator: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: mocks.getApplicationAdapters,
}));

vi.mock("$lib/server/workflows/dynamic-script-validation", () => ({
  validateDynamicScriptSpec: () => ({
    ok: true,
    meta: { name: "Secure preview workflow" },
  }),
  validateWithEvaluator: mocks.validateWithEvaluator,
  validateArgsAgainstMetaInput: () => ({ ok: true, args: {} }),
}));

import { startWorkflowRun } from "$lib/server/workflows/start-run";

const binding = {
  version: 1 as const,
  target: {
    previewName: "feature-one",
    environmentRequestId: "request-1",
    platformRevision: "a".repeat(40),
    sourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"c".repeat(64)}` as const,
  },
};

const developmentBinding = {
  version: 2 as const,
  parentExecutionId: "parent-execution",
  remoteActorUserId: "admin-1",
  operationId: `pdt-start-workflow-${"d".repeat(64)}`,
  target: binding.target,
  workflowSpecDigest: `sha256:${"e".repeat(64)}` as const,
};

describe("startWorkflowRun preview workspace authority", () => {
  const create = vi.fn();
  const getById = vi.fn();
  const prepare = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateWithEvaluator.mockResolvedValue({
      ok: true,
      meta: { name: "Secure preview workflow" },
    });
    prepare.mockReturnValue({
      ok: true,
      triggerData: {
        intent: "Build the dashboard",
        __previewDevelopment: { target: { previewName: "forged" } },
      },
      previewWorkspaceBinding: binding,
    });
    create.mockImplementation(async (input) => ({
      ...input,
      id: "execution-1",
    }));
    getById.mockResolvedValue(null);
    mocks.getApplicationAdapters.mockReturnValue({
      workflowData: {
        assertExecutionReadModelReady: vi.fn(async () => undefined),
      },
      workflowDefinitions: {
        getByRef: vi.fn(async () => ({
          id: "workflow-1",
          name: "Secure preview workflow",
          userId: "admin-1",
          projectId: "project-1",
          engineType: "dynamic-script",
          spec: {
            engine: "dynamic-script",
            script:
              "export const meta = { name: 'Secure preview workflow' }; return {};",
            meta: { name: "Secure preview workflow" },
          },
          daprOrchestratorUrl: "http://workflow-orchestrator",
        })),
      },
      workflowExecutions: {
        getById,
        create,
        markStartFailed: vi.fn(),
        attachSchedulerInstance: vi.fn(async () => undefined),
      },
      workflowLaunchPolicy: { prepare },
      workflowScheduler: {
        startScriptWorkflow: vi.fn(async () => ({
          instanceId: "script-instance-1",
        })),
      },
    });
  });

  it("persists server-derived authority in execution IR without rewriting args", async () => {
    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      userId: "admin-1",
      projectId: "project-1",
      triggerData: { intent: "untrusted input" },
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
    });

    expect(result).toMatchObject({
      ok: true,
      executionId: "execution-1",
    });
    const persisted = create.mock.calls[0]![0];
    expect(persisted.input).toEqual({
      intent: "Build the dashboard",
      __previewDevelopment: { target: { previewName: "forged" } },
    });
    expect(persisted.executionIr.args).toEqual(persisted.input);
    expect(persisted.executionIr.authority).toEqual({
      previewWorkspace: binding,
    });
  });

  it("persists server-derived preview development lineage beside workspace authority", async () => {
    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      userId: "admin-1",
      projectId: "project-1",
      triggerData: { intent: "untrusted input" },
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
      trustedPreviewDevelopmentBinding: developmentBinding,
    });

    expect(result.ok).toBe(true);
    expect(create.mock.calls[0]![0].executionIr.authority).toEqual({
      previewWorkspace: binding,
      previewDevelopment: developmentBinding,
    });
  });

  it("reuses an execution only when its immutable preview authority matches exactly", async () => {
    getById.mockResolvedValueOnce({
      id: "execution-1",
      workflowId: "workflow-1",
      projectId: "project-1",
      daprInstanceId: "script-instance-1",
      executionIr: {
        authority: {
          previewWorkspace: binding,
          previewDevelopment: developmentBinding,
        },
      },
    });

    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      userId: "admin-1",
      projectId: "project-1",
      triggerData: { intent: "untrusted input" },
      executionId: "execution-1",
      idempotent: true,
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
      trustedPreviewDevelopmentBinding: developmentBinding,
    });

    expect(result).toMatchObject({
      ok: true,
      executionId: "execution-1",
      reused: true,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    [
      "legacy execution with no authority",
      {
        engine: "dynamic-script",
      },
    ],
    [
      "stale preview generation",
      {
        authority: {
          previewWorkspace: {
            ...binding,
            target: {
              ...binding.target,
              environmentRequestId: "replacement-request",
            },
          },
          previewDevelopment: developmentBinding,
        },
      },
    ],
    [
      "missing preview development lineage",
      {
        authority: {
          previewWorkspace: binding,
        },
      },
    ],
  ])("rejects idempotent reuse of a %s", async (_label, executionIr) => {
    getById.mockResolvedValueOnce({
      id: "execution-1",
      workflowId: "workflow-1",
      projectId: "project-1",
      daprInstanceId: "script-instance-1",
      executionIr,
    });

    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      userId: "admin-1",
      projectId: "project-1",
      triggerData: { intent: "untrusted input" },
      executionId: "execution-1",
      idempotent: true,
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
      trustedPreviewDevelopmentBinding: developmentBinding,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Existing execution preview authority does not match this launch",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
