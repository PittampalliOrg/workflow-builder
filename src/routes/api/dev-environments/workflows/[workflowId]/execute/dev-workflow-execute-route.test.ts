import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowExecutionControlResult } from "$lib/server/application/workflow-execution-control";

const mocks = vi.hoisted(() => ({
  executeDevWorkflow: vi.fn(
    async (): Promise<WorkflowExecutionControlResult> => ({
      status: "ok",
      body: {
        executionId: "exec-1",
        instanceId: "instance-1",
        workflowId: "workflow-1",
        status: "running",
      },
    }),
  ),
  requirePlatformAdmin: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowExecutionControl: { executeDevWorkflow: mocks.executeDevWorkflow },
  }),
}));

vi.mock("$lib/server/platform-admin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));

import { POST } from "./+server";

function event(body: unknown = {
  input: { mode: "host-throwaway" },
  launchSurface: "forged",
}) {
  return {
    params: { workflowId: "workflow-1" },
    request: new Request("http://localhost", {
      method: "POST",
      headers: { origin: "https://wfb-feature-one.tail286401.ts.net" },
      body: JSON.stringify(body),
    }),
    locals: {
      session: { userId: "admin-1", projectId: "project-1" },
    },
  };
}

describe("Dev workflow execute route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats non-object JSON as an empty command body", async () => {
    const response = (await POST(event(null) as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.executeDevWorkflow).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      body: {},
      projectId: "project-1",
      requestOrigin: "https://wfb-feature-one.tail286401.ts.net",
      userId: "admin-1",
    });
  });

  it("stamps trusted Dev launch provenance only after the admin gate", async () => {
    const requestEvent = event();
    const response = (await POST(requestEvent as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledWith(
      requestEvent.locals,
    );
    expect(mocks.executeDevWorkflow).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      body: { input: { mode: "host-throwaway" } },
      projectId: "project-1",
      requestOrigin: "https://wfb-feature-one.tail286401.ts.net",
      userId: "admin-1",
    });
  });

  it("does not reach the application service when the admin gate rejects", async () => {
    mocks.requirePlatformAdmin.mockRejectedValueOnce({
      status: 403,
      body: { message: "Admin access required" },
    });

    await expect(Promise.resolve(POST(event() as never))).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.executeDevWorkflow).not.toHaveBeenCalled();
  });
});
