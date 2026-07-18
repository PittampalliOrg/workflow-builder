import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getApplicationAdapters: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: mocks.getApplicationAdapters,
}));

import { startWorkflowRun } from "$lib/server/workflows/start-run";

describe("startWorkflowRun launch policy", () => {
  const prepare = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    prepare.mockReturnValue({ ok: false, status: 409, error: "blocked" });
    mocks.getApplicationAdapters.mockReturnValue({
      workflowData: {
        assertExecutionReadModelReady: vi.fn(async () => undefined),
      },
      workflowDefinitions: {
        getByRef: vi.fn(async () => ({
          id: "workflow-1",
          name: "microservice-dev-session",
          projectId: "project-1",
          spec: {},
        })),
        getLatestByNameInProject: vi.fn(async () => ({
          id: "workflow-1",
          name: "microservice-dev-session",
          projectId: "project-1",
          spec: {},
        })),
      },
      workflowExecutions: {
        getById: vi.fn(async () => null),
      },
      workflowLaunchPolicy: { prepare },
    });
  });

  it("passes presentation launch context to the application policy", async () => {
    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      triggerData: { prompt: "change the UI" },
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
    });

    expect(prepare).toHaveBeenCalledWith({
      workflow: expect.objectContaining({ id: "workflow-1" }),
      triggerData: { prompt: "change the UI" },
      launchSurface: "dev-environment",
      launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
    });
    expect(result).toEqual({ ok: false, status: 409, error: "blocked" });
  });

	it("fails closed before launch when the executable spec digest changed", async () => {
		const result = await startWorkflowRun({
			workflowId: "workflow-1",
			triggerData: { prompt: "change the UI" },
			launchSurface: "dev-environment",
			launchOrigin: "https://wfb-feature-one.tail286401.ts.net",
			expectedWorkflowSpecDigest: `sha256:${"f".repeat(64)}`,
		});

		expect(result).toEqual({
			ok: false,
			status: 409,
      error:
        "Workflow spec digest does not match the expected executable contract",
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("fails closed when the workflow is outside the authenticated project", async () => {
    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      projectId: "project-2",
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "Workflow not found",
		});
		expect(prepare).not.toHaveBeenCalled();
	});

  it("resolves workflow names inside the authenticated project", async () => {
    await startWorkflowRun({
      workflowName: " microservice-dev-session ",
      projectId: "project-1",
    });

    const app = mocks.getApplicationAdapters.mock.results[0].value;
    expect(
      app.workflowDefinitions.getLatestByNameInProject,
    ).toHaveBeenCalledWith("microservice-dev-session", "project-1");
    expect(app.workflowDefinitions.getByRef).not.toHaveBeenCalled();
  });

  it("rejects an idempotency key already used in another workflow scope", async () => {
    prepare.mockReturnValue({ ok: true, triggerData: {} });
    const app = mocks.getApplicationAdapters();
    app.workflowExecutions.getById.mockResolvedValue({
      id: "execution-1",
      workflowId: "workflow-other",
      projectId: "project-other",
    });

    const result = await startWorkflowRun({
      workflowId: "workflow-1",
      projectId: "project-1",
      executionId: "execution-1",
      idempotent: true,
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "Execution id already belongs to a different workflow scope",
    });
  });
});
