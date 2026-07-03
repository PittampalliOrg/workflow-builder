import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const workflowExecutionControl = {
    getApprovalState: vi.fn(
      async (): Promise<unknown> => ({
        status: "ok" as const,
        body: {
          awaiting: true,
          nodeId: "goal_spec_approval",
          eventType: "goal_spec_approval",
        },
      }),
    ),
  };
  return { workflowExecutionControl };
});

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowExecutionControl: mocks.workflowExecutionControl,
  }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
  return {
    params: { executionId: "exec-1" },
    locals: { session: { userId: "user-1", projectId: "project-1" } },
    ...overrides,
  };
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
  try {
    const result = await promise;
    expect((result as { status?: number }).status).toBe(status);
  } catch (err) {
    expect((err as { status?: number }).status).toBe(status);
  }
}

describe("workflow execution approval-state route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the route behind workflow-data application services", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("getApplicationAdapters");
    expect(source).toContain("workflowExecutionControl");
    expect(source).toContain("getApprovalState");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("workflowData");
    expect(source).not.toContain("assertInScope");
    expect(source).not.toContain("findListenGate");
  });

  it("reports an awaiting approval gate from application service data", async () => {
    const response = (await GET(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      awaiting: true,
      nodeId: "goal_spec_approval",
      eventType: "goal_spec_approval",
    });
    expect(
      mocks.workflowExecutionControl.getApprovalState,
    ).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
  });

  it("returns non-awaiting responses from the application service", async () => {
    mocks.workflowExecutionControl.getApprovalState.mockResolvedValueOnce({
      status: "ok",
      body: { awaiting: false },
    });

    const response = (await GET(event() as never)) as Response;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ awaiting: false });
  });

  it("maps application-service not-found responses", async () => {
    mocks.workflowExecutionControl.getApprovalState.mockResolvedValueOnce({
      status: "error",
      httpStatus: 404,
      message: "Execution not found",
    });

    await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
  });
});
