import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mintWorkflowMcpPrincipalAssertion,
  verifyWorkflowMcpPrincipalAssertion,
} from "./workflow-mcp-principal-assertion";

const principal = {
  userId: "user-1",
  projectId: "project-1",
  sessionId: "session-1",
  scopes: ["workflow:execute", "workflow:read"],
  capabilities: {
    scriptDepth: 2,
    teamId: "team-session-1",
    teamRole: "lead" as const,
  },
};
const now = new Date("2026-07-18T12:00:00.000Z");

describe("Workflow MCP principal assertions", () => {
  beforeEach(() => {
    process.env.JWT_SIGNING_KEY = "test-workflow-mcp-signing-key";
    process.env.WORKFLOW_MCP_PRINCIPAL_ASSERTION_TTL_SECONDS = "60";
  });

  afterEach(() => {
    delete process.env.JWT_SIGNING_KEY;
    delete process.env.WORKFLOW_MCP_PRINCIPAL_ASSERTION_TTL_SECONDS;
  });

  it("round-trips a short-lived workspace principal", () => {
    const token = mintWorkflowMcpPrincipalAssertion(principal, now);
    expect(verifyWorkflowMcpPrincipalAssertion(token, now)).toEqual({
      ...principal,
      scopes: ["workflow:execute", "workflow:read"],
    });
  });

  it("rejects tampering and expiry", () => {
    const token = mintWorkflowMcpPrincipalAssertion(principal, now);
    const [prefix, payload, signature] = token.split(".");
    const tampered = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(
      verifyWorkflowMcpPrincipalAssertion(
        `${prefix}.${payload}.${tampered}`,
        now,
      ),
    ).toBeNull();
    expect(
      verifyWorkflowMcpPrincipalAssertion(
        token,
        new Date(now.getTime() + 61_000),
      ),
    ).toBeNull();
  });
});
