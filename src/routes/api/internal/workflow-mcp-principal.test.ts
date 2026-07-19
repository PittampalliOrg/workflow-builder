import { describe, expect, it, vi } from "vitest";
import { resolveInternalWorkflowPrincipal } from "./workflow-mcp-principal";

describe("resolveInternalWorkflowPrincipal", () => {
  it("translates trusted request headers into an application command", async () => {
    const authorize = vi.fn(async () => ({
      ok: true as const,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "session-1",
        scopes: ["workflow:write"],
        capabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none" as const,
        },
      },
    }));
    const request = new Request("http://workflow-builder.test/internal", {
      headers: {
        "X-Wfb-Principal-Assertion": "signed-principal",
        "X-Wfb-Session-Id": "session-1",
        "X-Wfb-Session-Token": "signed-session",
      },
    });

    await expect(
      resolveInternalWorkflowPrincipal(
        request,
        { authorize },
        { requiredScope: "workflow:write" },
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(authorize).toHaveBeenCalledWith({
      assertionToken: "signed-principal",
      platformToken: "signed-session",
      legacyUserId: undefined,
      legacyProjectId: undefined,
      sessionId: "session-1",
      requiredScope: "workflow:write",
    });
  });
});
