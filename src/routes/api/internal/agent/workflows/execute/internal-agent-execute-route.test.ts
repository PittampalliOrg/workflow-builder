import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  authorizePrincipal: vi.fn(),
  startWorkflowRun: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    internalWorkflowPrincipal: { authorize: mocks.authorizePrincipal },
  }),
}));

vi.mock("$lib/server/workflows/start-run", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
}));

import { POST } from "./+server";

function request(headers: Record<string, string>): Request {
  return new Request(
    "http://workflow-builder.test/api/internal/agent/workflows/execute",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        workflowId: "workflow-1",
        triggerData: { topic: "test" },
      }),
    },
  );
}

function call(req: Request) {
  return POST({ request: req } as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizePrincipal.mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      projectId: "project-1",
      sessionId: null,
      scopes: ["workflow:execute"],
    },
  });
  mocks.startWorkflowRun.mockResolvedValue({
    ok: true,
    executionId: "execution-1",
    instanceId: "instance-1",
    workflowId: "workflow-1",
    workflowName: "Workflow",
    status: "running",
  });
});

describe("POST /api/internal/agent/workflows/execute", () => {
  it("passes the authenticated workspace principal to the canonical start path", async () => {
    const response = await call(
      request({
        "X-Wfb-Principal-Assertion": "signed-principal",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.startWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "workflow-1",
        userId: "user-1",
        projectId: "project-1",
      }),
    );
  });

  it("rejects calls without a principal or trusted session", async () => {
    mocks.authorizePrincipal.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error:
        "An authenticated workspace principal or trusted platform session is required",
    });
    const response = await call(request({}));
    expect(response.status).toBe(400);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("preserves the explicit trusted workflow-trigger system lane", async () => {
    const response = await call(
      request({ "X-Wfb-System-Principal": "workflow-trigger" }),
    );
    expect(response.status).toBe(200);
    const startInput = mocks.startWorkflowRun.mock.calls[0]?.[0];
    expect(startInput).toMatchObject({ workflowId: "workflow-1" });
    expect(startInput).not.toHaveProperty("userId");
    expect(startInput).not.toHaveProperty("projectId");
    expect(mocks.authorizePrincipal).not.toHaveBeenCalled();
  });

  it("rejects ambiguous system and user context", async () => {
    const response = await call(
      request({
        "X-Wfb-System-Principal": "workflow-trigger",
        "X-Wfb-Session-Id": "session-1",
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });
});
