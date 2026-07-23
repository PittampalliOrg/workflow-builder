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

describe("startWorkflowRun preview workspace authority", () => {
  const create = vi.fn();
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
        getById: vi.fn(async () => null),
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
});
