import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  resolveInternalWorkflowPrincipal: vi.fn(async () => ({
    ok: true as const,
    principal: {
      userId: "user-1",
      projectId: "project-1",
      scopes: ["workflow:read", "workflow:execute"],
    },
  })),
  isPlatformAdmin: vi.fn(async () => true),
  isControlPlane: vi.fn(() => true),
  allowsPreviewName: vi.fn(() => true),
  internalWorkflowPrincipal: { authorize: vi.fn() },
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    internalWorkflowPrincipal: mocks.internalWorkflowPrincipal,
    workflowData: { isPlatformAdmin: mocks.isPlatformAdmin },
    previewDeploymentScope: {
      isControlPlane: mocks.isControlPlane,
      allowsPreviewName: mocks.allowsPreviewName,
    },
  }),
}));
vi.mock("../workflow-mcp-principal", () => ({
  resolveInternalWorkflowPrincipal: mocks.resolveInternalWorkflowPrincipal,
}));

import { guardPreviewMcp } from "./guard";

function request(): Request {
  return new Request("http://localhost/api/internal/preview-environments", {
    headers: {
      "X-Internal-Token": "internal-token",
      "X-Wfb-Principal-Assertion": "signed-principal",
    },
  });
}

describe("Workflow MCP preview route guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.resolveInternalWorkflowPrincipal.mockResolvedValue({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        scopes: ["workflow:read", "workflow:execute"],
      },
    });
    mocks.isPlatformAdmin.mockResolvedValue(true);
    mocks.isControlPlane.mockReturnValue(true);
    mocks.allowsPreviewName.mockReturnValue(true);
  });

  it("requires both service authentication and the requested signed scope", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    const unauthorized = await guardPreviewMcp(request(), {
      requiredScope: "workflow:read",
    });
    expect(unauthorized.ok).toBe(false);
    expect(!unauthorized.ok && unauthorized.response.status).toBe(401);
    expect(mocks.resolveInternalWorkflowPrincipal).not.toHaveBeenCalled();

    mocks.resolveInternalWorkflowPrincipal.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "missing workflow:execute",
    } as never);
    const denied = await guardPreviewMcp(request(), {
      requiredScope: "workflow:execute",
    });
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.response.status).toBe(403);
    expect(mocks.resolveInternalWorkflowPrincipal).toHaveBeenLastCalledWith(
      expect.any(Request),
      mocks.internalWorkflowPrincipal,
      { requiredScope: "workflow:execute" },
    );
  });

  it("preserves the deployment-scope boundary for fleet and per-preview reads", async () => {
    mocks.isControlPlane.mockReturnValueOnce(false);
    const fleet = await guardPreviewMcp(request(), {
      requiredScope: "workflow:read",
      controlPlane: true,
    });
    expect(fleet.ok).toBe(false);
    expect(!fleet.ok && fleet.response.status).toBe(403);

    mocks.allowsPreviewName.mockReturnValueOnce(false);
    const crossPreview = await guardPreviewMcp(request(), {
      requiredScope: "workflow:read",
      previewName: "another-preview",
    });
    expect(crossPreview.ok).toBe(false);
    expect(!crossPreview.ok && crossPreview.response.status).toBe(403);
    expect(mocks.allowsPreviewName).toHaveBeenCalledWith("another-preview");
  });

  it("keeps platform-admin authorization authoritative in the BFF", async () => {
    mocks.isPlatformAdmin.mockResolvedValueOnce(false);
    const result = await guardPreviewMcp(request(), {
      requiredScope: "workflow:execute",
      admin: true,
      controlPlane: true,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.response.status).toBe(403);
    expect(mocks.isPlatformAdmin).toHaveBeenCalledWith("user-1");
  });
});
