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
          spec: {},
        })),
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
			error: "Workflow spec digest does not match the expected executable contract",
		});
		expect(prepare).not.toHaveBeenCalled();
	});
});
