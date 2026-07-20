import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveWorkflowMcpContext,
  type WorkflowMcpPrincipal,
  workflowMcpSessionToolAccess,
} from "./auth-context.js";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const RESOLVED = {
  authenticated: true,
  authMode: "workspace_api_key" as const,
  userId: "user-1",
  projectId: "project-1",
  scopes: ["workflow:read", "workflow:write", "workflow:execute"],
  apiKeyId: "key-1",
  principalAssertion: "signed-principal-assertion",
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" as const },
};

describe("resolveWorkflowMcpContext", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns setup-only context when no credential is present", async () => {
    const fetchImpl = vi.fn();
    const context = await resolveWorkflowMcpContext(
      { "x-wfb-session-id": "raw-session-is-not-auth" },
      { fetchImpl: fetchImpl as any, internalApiToken: "internal" },
    );

    expect(context.principal).toBeNull();
    expect(context.error?.code).toBe("workspace_auth_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves a workspace Bearer key through the BFF", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RESOLVED));
    const context = await resolveWorkflowMcpContext(
      { authorization: "Bearer wfb_secret" },
      {
        fetchImpl: fetchImpl as any,
        internalApiToken: "internal",
        workflowBuilderUrl: "http://bff",
      },
    );

    expect(context.error).toBeUndefined();
    expect(context.principal).toMatchObject({
      authMode: "workspace_api_key",
      userId: "user-1",
      projectId: "project-1",
      scopes: RESOLVED.scopes,
      principalAssertion: "signed-principal-assertion",
      capabilities: RESOLVED.capabilities,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://bff/api/internal/auth/workflow-mcp-principal");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer wfb_secret",
    );
    expect((init.headers as Record<string, string>)["X-Internal-Token"]).toBe(
      "internal",
    );
  });

  it("rejects a valid legacy key that is not workspace-bound", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ...RESOLVED, projectId: null }),
    );
    const context = await resolveWorkflowMcpContext(
      { authorization: "Bearer wfb_legacy" },
      { fetchImpl: fetchImpl as any, internalApiToken: "internal" },
    );

    expect(context.principal).toBeNull();
    expect(context.error?.code).toBe("workspace_key_required");
  });

  it.each([
    [404, "session_not_found"],
    [403, "session_inactive"],
    [403, "session_principal_mismatch"],
  ])(
    "maps BFF session context failures to actionable MCP guidance",
    async (status, code) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse(status, { code, error: "Session context is invalid" }),
      );

      const context = await resolveWorkflowMcpContext(
        {
          authorization: "Bearer wfb_secret",
          "x-wfb-session-id": "stale-session",
        },
        { fetchImpl: fetchImpl as any, internalApiToken: "internal" },
      );

      expect(context.principal).toBeNull();
      expect(context.error?.code).toBe("session_context_invalid");
      expect(context.error?.message).toContain("unset WFB_MCP_SESSION_ID");
    },
  );

  it("accepts a signed platform session only when ownership matches", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ...RESOLVED,
        authMode: "platform_session",
        capabilities: {
          scriptDepth: 1,
          teamId: "team-1",
          teamRole: "member",
        },
      }),
    );
    const context = await resolveWorkflowMcpContext(
      {
        "x-wfb-session-id": "session-1",
        "x-wfb-session-token": "signed-token",
      },
      { fetchImpl: fetchImpl as any, internalApiToken: "internal" },
    );

    expect(context.principal).toMatchObject({
      authMode: "platform_session",
      sessionId: "session-1",
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "member",
      },
    } satisfies Partial<WorkflowMcpPrincipal>);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(
      (init.headers as Record<string, string>)["X-Wfb-Session-Token"],
    ).toBe("signed-token");
  });

  it("refreshes an expired platform credential through the internal BFF lane", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(401, {
          code: "invalid_platform_session_token",
          error: "expired",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          workflowMcpSessionToken: "refreshed-session-token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...RESOLVED,
          authMode: "platform_session",
        }),
      );
    const context = await resolveWorkflowMcpContext(
      {
        "x-wfb-session-id": "refresh-session-1",
        "x-wfb-session-token": "expired-session-token-1",
      },
      {
        fetchImpl: fetchImpl as any,
        internalApiToken: "internal",
        workflowBuilderUrl: "http://bff",
      },
    );

    expect(context.principal?.authMode).toBe("platform_session");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "http://bff/api/internal/auth/workflow-mcp-session/refresh",
    );
    expect(
      (fetchImpl.mock.calls[2]?.[1]?.headers as Record<string, string>)[
        "X-Wfb-Session-Token"
      ],
    ).toBe("refreshed-session-token");
  });

  it("forwards optional session lineage to the authoritative BFF resolver", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, RESOLVED));
    const context = await resolveWorkflowMcpContext(
      {
        authorization: "Bearer wfb_secret",
        "x-wfb-session-id": "session-2",
      },
      { fetchImpl: fetchImpl as any, internalApiToken: "internal" },
    );

    expect(context.principal).toMatchObject({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-2",
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["X-Wfb-Session-Id"]).toBe(
      "session-2",
    );
  });
});

describe("workflowMcpSessionToolAccess", () => {
  const principal = {
    authMode: "platform_session",
    userId: "user-1",
    projectId: "project-1",
    sessionId: "session-1",
    principalAssertion: "assertion",
    capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
  } satisfies Omit<WorkflowMcpPrincipal, "scopes">;

  it("omits every session tool group when its scope is absent", () => {
    expect(
      workflowMcpSessionToolAccess({ ...principal, scopes: ["workflow:read"] }),
    ).toEqual({ team: false });
  });

  it("exposes only explicitly scoped session tool groups", () => {
    expect(
      workflowMcpSessionToolAccess({
        ...principal,
        scopes: ["session:team", "session:trace"],
      }),
    ).toEqual({ team: true });
  });

  it("never exposes session tools without signed session lineage", () => {
    expect(
      workflowMcpSessionToolAccess({
        ...principal,
        sessionId: undefined,
        scopes: ["session:team", "session:trace"],
      }),
    ).toEqual({ team: false });
  });
});
