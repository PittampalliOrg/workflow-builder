import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  authorizePrincipal: vi.fn(),
  getScopedWorkflowByName: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    internalWorkflowPrincipal: { authorize: mocks.authorizePrincipal },
    workflowData: {
      getScopedWorkflowByName: mocks.getScopedWorkflowByName,
    },
    workflowDefinitionCommands: {
      createWorkflow: mocks.createWorkflow,
      updateWorkflow: mocks.updateWorkflow,
    },
  }),
}));

vi.mock("$lib/server/workflows/dynamic-script-validation", () => ({
  extractStaticMeta: () => ({ name: "Saved workflow" }),
}));

import { POST } from "./+server";

const SCRIPT = "export const meta = { name: 'Saved workflow' }; return {};";

function request(headers: Record<string, string>): Request {
  return new Request(
    "http://workflow-builder.test/api/internal/agent/workflows/save-script",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ script: SCRIPT }),
    },
  );
}

function call(req: Request) {
  return POST({ request: req } as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.validateInternalToken.mockReturnValue(true);
  mocks.authorizePrincipal.mockResolvedValue({
    ok: true,
    principal: {
      userId: "user-1",
      projectId: "project-1",
      sessionId: null,
      scopes: ["workflow:write"],
    },
  });
  mocks.getScopedWorkflowByName.mockResolvedValue(null);
  mocks.createWorkflow.mockResolvedValue({
    status: "ok",
    httpStatus: 201,
    body: { id: "workflow-1" },
  });
});

describe("POST /api/internal/agent/workflows/save-script", () => {
  it("saves under a trusted workspace principal without a session", async () => {
    const response = await call(
      request({
        "X-Wfb-Principal-Assertion": "signed-principal",
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", projectId: "project-1" }),
    );
    expect(mocks.getScopedWorkflowByName).toHaveBeenCalledWith({
      workflowName: "Saved workflow",
      userId: "user-1",
      projectId: "project-1",
    });
  });

  it("updates only a same-project dynamic-script workflow", async () => {
    mocks.getScopedWorkflowByName.mockResolvedValueOnce({
      id: "workflow-existing",
      engineType: "dynamic-script",
      projectId: "project-1",
    });
    mocks.updateWorkflow.mockResolvedValueOnce({
      status: "ok",
      httpStatus: 200,
      body: { id: "workflow-existing" },
    });

    const response = await call(
      request({ "X-Wfb-Principal-Assertion": "signed-principal" }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: "workflow-existing" }),
    );
    expect(mocks.createWorkflow).not.toHaveBeenCalled();
  });

  it("keeps the trusted internal platform-session fallback", async () => {
    const response = await call(request({ "X-Wfb-Session-Id": "session-1" }));
    expect(response.status).toBe(200);
    expect(mocks.createWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", projectId: "project-1" }),
    );
  });

  it("rejects session lineage that does not match the principal", async () => {
    mocks.authorizePrincipal.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Session lineage does not match the signed Workflow MCP principal",
    });
    const response = await call(
      request({
        "X-Wfb-Principal-Assertion": "mismatched-principal",
        "X-Wfb-Session-Id": "session-1",
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.createWorkflow).not.toHaveBeenCalled();
  });
});
