import { describe, expect, it } from "vitest";
import {
  runWithWorkflowMcpContext,
  type WorkflowMcpRequestContext,
} from "./auth-context.js";
import { runWithGoalContext } from "./goal-context.js";
import { currentTeamActionHeaders } from "./team-tools.js";

const context: WorkflowMcpRequestContext = {
  principal: {
    authMode: "platform_session",
    userId: "user-1",
    projectId: "project-1",
    scopes: ["session:team"],
    sessionId: "session-1",
    principalAssertion: "signed-team-principal",
    capabilities: {
      scriptDepth: 0,
      teamId: "team-session-1",
      teamRole: "lead",
    },
  },
};

describe("Workflow MCP team action headers", () => {
  it("forwards the signed principal assertion and its exact session lineage", () => {
    const headers = runWithWorkflowMcpContext(context, () =>
      runWithGoalContext({ sessionId: "session-1" }, () =>
        currentTeamActionHeaders(),
      ),
    );

    expect(headers).toMatchObject({
      "X-Wfb-Principal-Assertion": "signed-team-principal",
      "X-Wfb-Session-Id": "session-1",
    });
    expect(headers).not.toHaveProperty("X-Wfb-Principal-User-Id");
  });

  it("rejects a request context whose session differs from the assertion", () => {
    expect(() =>
      runWithWorkflowMcpContext(context, () =>
        runWithGoalContext({ sessionId: "other-session" }, () =>
          currentTeamActionHeaders(),
        ),
      ),
    ).toThrow("signed Workflow MCP session principal");
  });
});
