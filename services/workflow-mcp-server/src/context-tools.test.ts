import { describe, expect, it } from "vitest";
import { workflowContextDocument } from "./context-tools.js";

describe("workflowContextDocument", () => {
  it("explains how to authenticate without asking for a session id", () => {
    const document = workflowContextDocument({
      principal: null,
      error: {
        code: "workspace_auth_required",
        message: "Authenticate first.",
      },
    });

    expect(document.authenticated).toBe(false);
    expect(document.setup).toMatchObject({
      header: "Authorization: Bearer <workspace API key>",
    });
    expect(JSON.stringify(document)).toContain("Do not supply a sessionId");
  });

  it("reports the selected workspace, scopes, and optional lineage", () => {
    const document = workflowContextDocument({
      principal: {
        authMode: "workspace_api_key",
        userId: "user-1",
        projectId: "project-1",
        workspace: { id: "project-1", slug: "demo", name: "Demo" },
        sessionId: "session-1",
        scopes: ["workflow:read", "workflow:write"],
        principalAssertion: "signed-principal-assertion",
        capabilities: {
          scriptDepth: 0,
          teamId: null,
          teamRole: "none",
        },
      },
    });

    expect(document).toMatchObject({
      authenticated: true,
      workspace: { id: "project-1", slug: "demo", name: "Demo" },
      session: { attached: true, sessionId: "session-1" },
      capabilities: {
        workflowRead: true,
        workflowWrite: true,
        workflowExecute: false,
        agentWrite: false,
      },
    });
  });
});
