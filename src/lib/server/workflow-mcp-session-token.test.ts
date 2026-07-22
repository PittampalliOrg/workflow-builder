import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mintWorkflowMcpSessionToken,
  verifyWorkflowMcpSessionToken,
  verifyWorkflowMcpSessionTokenForRefresh,
} from "./workflow-mcp-session-token";

const identity = {
  userId: "user-1",
  projectId: "project-1",
  sessionId: "session-1",
  capabilities: {
    scriptDepth: 1,
    teamId: "team-1",
    teamRole: "member" as const,
  },
};
const now = new Date("2026-07-18T12:00:00.000Z");

describe("Workflow MCP session tokens", () => {
  beforeEach(() => {
    delete process.env.ORIGIN;
    delete process.env.WORKFLOW_MCP_SESSION_TOKEN_AUDIENCE;
    process.env.JWT_SIGNING_KEY = "test-workflow-mcp-signing-key";
    process.env.APP_PUBLIC_URL = "https://workflow-builder-dev.example.test";
    process.env.WORKFLOW_MCP_SESSION_TOKEN_TTL_SECONDS = "3600";
  });

  afterEach(() => {
    delete process.env.JWT_SIGNING_KEY;
    delete process.env.APP_PUBLIC_URL;
    delete process.env.ORIGIN;
    delete process.env.WORKFLOW_MCP_SESSION_TOKEN_AUDIENCE;
    delete process.env.WORKFLOW_MCP_SESSION_TOKEN_TTL_SECONDS;
    delete process.env.WORKFLOW_MCP_SESSION_TOKEN_REFRESH_GRACE_SECONDS;
  });

  it("round-trips a scoped platform session identity", () => {
    const token = mintWorkflowMcpSessionToken(identity, now);
    expect(verifyWorkflowMcpSessionToken(token, now)).toEqual(identity);
  });

  it("rejects tampered tokens", () => {
    const token = mintWorkflowMcpSessionToken(identity, now);
    const [prefix, payload, signature] = token.split(".");
    const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    expect(
      verifyWorkflowMcpSessionToken(
        `${prefix}.${payload}.${tamperedSignature}`,
        now,
      ),
    ).toBeNull();
  });

  it("rejects expired tokens and tokens minted for another environment", () => {
    const token = mintWorkflowMcpSessionToken(identity, now);
    expect(
      verifyWorkflowMcpSessionToken(token, new Date(now.getTime() + 3_600_000)),
    ).toBeNull();

    process.env.APP_PUBLIC_URL =
      "https://workflow-builder-staging.example.test";
    expect(verifyWorkflowMcpSessionToken(token, now)).toBeNull();
  });

  it("keeps an explicit preview audience valid across traffic handoff", () => {
    process.env.WORKFLOW_MCP_SESSION_TOKEN_AUDIENCE = "preview-native-v1";
    process.env.APP_PUBLIC_URL =
      "https://workflow-builder-ryzen.tail286401.ts.net";
    const token = mintWorkflowMcpSessionToken(identity, now);

    process.env.APP_PUBLIC_URL = "https://wfb-preview-dev.tail286401.ts.net";
    process.env.ORIGIN = "https://wfb-preview-dev.tail286401.ts.net";
    expect(verifyWorkflowMcpSessionToken(token, now)).toEqual(identity);

    process.env.WORKFLOW_MCP_SESSION_TOKEN_AUDIENCE = "another-preview-lane";
    expect(verifyWorkflowMcpSessionToken(token, now)).toBeNull();
  });

  it("permits bounded refresh of an expired, correctly signed token", () => {
    process.env.WORKFLOW_MCP_SESSION_TOKEN_REFRESH_GRACE_SECONDS = "7200";
    const token = mintWorkflowMcpSessionToken(identity, now);
    const afterExpiry = new Date(now.getTime() + 4_000_000);
    expect(verifyWorkflowMcpSessionToken(token, afterExpiry)).toBeNull();
    expect(verifyWorkflowMcpSessionTokenForRefresh(token, afterExpiry)).toEqual(
      identity,
    );
    expect(
      verifyWorkflowMcpSessionTokenForRefresh(
        token,
        new Date(now.getTime() + 11_000_000),
      ),
    ).toBeNull();
  });

  it("fails closed without the signing secret", () => {
    delete process.env.JWT_SIGNING_KEY;
    expect(() => mintWorkflowMcpSessionToken(identity, now)).toThrow(
      /JWT_SIGNING_KEY/,
    );
  });
});
