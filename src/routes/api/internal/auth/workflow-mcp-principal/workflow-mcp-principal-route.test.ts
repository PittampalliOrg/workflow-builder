import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireInternal: vi.fn(),
  resolve: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requireInternal: mocks.requireInternal,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowMcpPrincipal: { resolve: mocks.resolve },
  }),
}));

import { POST } from "./+server";

function request(headers: Record<string, string>): Request {
  return new Request(
    "http://workflow-builder.test/api/internal/auth/workflow-mcp-principal",
    {
      method: "POST",
      headers: { "X-Internal-Token": "internal", ...headers },
    },
  );
}

function call(req: Request) {
  return POST({ request: req } as Parameters<typeof POST>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    ok: true,
    principal: {
      authMode: "workspace_api_key",
      apiKeyId: "key-1",
      userId: "user-1",
      projectId: "project-1",
      workspace: {
        id: "project-1",
        slug: "demo-workspace",
        name: "Demo workspace",
      },
      scopes: ["workflow:read"],
      sessionId: null,
      capabilities: {
        scriptDepth: 0,
        teamId: null,
        teamRole: "none",
      },
      principalAssertion: "signed-principal",
    },
  });
});

describe("POST /api/internal/auth/workflow-mcp-principal", () => {
  it("passes transport credentials to the application service", async () => {
    const response = await call(
      request({
        Authorization: "Bearer wfb_secret",
        "X-Wfb-Session-Id": "session-1",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith({
      authorizationHeader: "Bearer wfb_secret",
      platformToken: "",
      requestedSessionId: "session-1",
    });
    expect(await response.json()).toEqual(
      expect.objectContaining({
        authenticated: true,
        principalAssertion: "signed-principal",
      }),
    );
  });

  it("maps an application authorization error", async () => {
    mocks.resolve.mockResolvedValueOnce({
      ok: false,
      status: 403,
      code: "workspace_membership_required",
      error: "Workspace membership is required",
    });

    const response = await call(request({ Authorization: "Bearer stale" }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      authenticated: false,
      code: "workspace_membership_required",
      error: "Workspace membership is required",
    });
  });
});
