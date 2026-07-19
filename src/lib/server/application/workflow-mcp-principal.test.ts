import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowMcpPrincipalService } from "./workflow-mcp-principal";
import type {
  WorkflowMcpPrincipalDataPort,
  WorkflowMcpSessionTokenRefreshVerifier,
  WorkflowMcpTeamMemberReader,
} from "./ports/workflow-mcp-auth";
import type { WorkspaceProjectMembershipDetail } from "./ports/platform";

const workspace: WorkspaceProjectMembershipDetail = {
  id: "project-1",
  displayName: "Demo workspace",
  externalId: "demo-workspace",
  selfRole: "ADMIN",
};

function harness() {
  const resolveApiKey = vi.fn<WorkflowMcpPrincipalDataPort["resolveApiKey"]>(
    async () => ({
      valid: true,
      apiKeyId: "key-1",
      userId: "user-1",
      projectId: "project-1",
      scopes: ["workflow:read", "workflow:write", "workflow:execute"],
    }),
  );
  const getSessionFileOwner = vi.fn<
    WorkflowMcpPrincipalDataPort["getSessionFileOwner"]
  >(async () => ({
    id: "session-1",
    userId: "user-1",
    projectId: "project-1",
  }));
  const getWorkspaceProjectMembershipDetail = vi.fn<
    WorkflowMcpPrincipalDataPort["getWorkspaceProjectMembershipDetail"]
  >(async () => workspace);
  const hasActiveWorkspaceProjectMembership = vi.fn<
    WorkflowMcpPrincipalDataPort["hasActiveWorkspaceProjectMembership"]
  >(async () => true);
  const data = {
    resolveApiKey,
    getSessionFileOwner,
    getWorkspaceProjectMembershipDetail,
    hasActiveWorkspaceProjectMembership,
  };
  const getTeam = vi.fn<WorkflowMcpTeamMemberReader["getTeam"]>(async () => ({
    id: "team-1",
    lead_session_id: "lead-session",
    status: "active",
  }));
  const getMemberBySession = vi.fn<
    WorkflowMcpTeamMemberReader["getMemberBySession"]
  >(async () => ({
    team_id: "team-1",
    role: "member",
    status: "working",
  }));
  const teamMembers = {
    getTeam,
    getMemberBySession,
  };
  const sessionTokens = {
    verify: vi.fn(() => ({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "member" as const,
      },
    })),
    verifyForRefresh: vi.fn<
      WorkflowMcpSessionTokenRefreshVerifier["verifyForRefresh"]
    >(() => ({
      userId: "user-1",
      projectId: "project-1",
      sessionId: "session-1",
      capabilities: {
        scriptDepth: 1,
        teamId: "team-1",
        teamRole: "member" as const,
      },
    })),
    sign: vi.fn(() => "refreshed-session-token"),
  };
  const principalAssertions = { sign: vi.fn(() => "signed-principal") };

  return {
    data,
    teamMembers,
    sessionTokens,
    principalAssertions,
    service: new ApplicationWorkflowMcpPrincipalService({
      data,
      teamMembers,
      sessionTokens,
      principalAssertions,
    }),
  };
}

describe("ApplicationWorkflowMcpPrincipalService", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("refreshes only a still-authorized active platform session", async () => {
    await expect(
      h.service.refreshPlatformSession({
        platformToken: "expired-but-signed",
        requestedSessionId: "session-1",
      }),
    ).resolves.toMatchObject({
      ok: true,
      sessionToken: "refreshed-session-token",
      principal: { sessionId: "session-1" },
    });
    expect(h.sessionTokens.verifyForRefresh).toHaveBeenCalledWith(
      "expired-but-signed",
    );

    h.sessionTokens.verifyForRefresh.mockReturnValueOnce(null);
    await expect(
      h.service.refreshPlatformSession({
        platformToken: "invalid",
        requestedSessionId: "session-1",
      }),
    ).resolves.toMatchObject({ ok: false, status: 401 });
  });

  it("resolves a workspace API key and signs the scoped principal", async () => {
    const result = await h.service.resolve({
      authorizationHeader: "Bearer wfb_secret",
      platformToken: "",
      requestedSessionId: "",
    });

    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        authMode: "workspace_api_key",
        apiKeyId: "key-1",
        userId: "user-1",
        projectId: "project-1",
        workspace: {
          id: "project-1",
          slug: "demo-workspace",
          name: "Demo workspace",
        },
        sessionId: null,
        principalAssertion: "signed-principal",
      }),
    });
    expect(h.principalAssertions.sign).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
      sessionId: null,
      scopes: ["workflow:read", "workflow:write", "workflow:execute"],
      capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
    });
  });

  it("rejects ambiguous credentials and legacy unscoped keys", async () => {
    await expect(
      h.service.resolve({
        authorizationHeader: "Bearer wfb_secret",
        platformToken: "signed-session",
        requestedSessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 400,
        code: "ambiguous_workflow_mcp_credential",
      }),
    );

    h.data.resolveApiKey.mockResolvedValueOnce({
      valid: true,
      apiKeyId: "legacy",
      userId: "user-1",
      projectId: null,
      scopes: [],
    });
    await expect(
      h.service.resolve({
        authorizationHeader: "Bearer wfb_legacy",
        platformToken: "",
        requestedSessionId: "",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        code: "workspace_key_required",
      }),
    );
  });

  it("validates optional API-key session lineage", async () => {
    h.data.getSessionFileOwner.mockResolvedValueOnce({
      id: "session-2",
      userId: "other-user",
      projectId: "project-1",
    });

    await expect(
      h.service.resolve({
        authorizationHeader: "Bearer wfb_secret",
        platformToken: "",
        requestedSessionId: "session-2",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        code: "session_principal_mismatch",
      }),
    );
  });

  it("resolves a signed platform session and revalidates team membership", async () => {
    const result = await h.service.resolve({
      authorizationHeader: null,
      platformToken: "signed-session",
      requestedSessionId: "session-1",
    });

    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        authMode: "platform_session",
        sessionId: "session-1",
        capabilities: {
          scriptDepth: 1,
          teamId: "team-1",
          teamRole: "member",
        },
      }),
    });
    expect(h.teamMembers.getMemberBySession).toHaveBeenCalledWith("session-1");
  });

  it("derives platform scopes from the live role and strips viewer team authority", async () => {
    h.data.getWorkspaceProjectMembershipDetail.mockResolvedValueOnce({
      ...workspace,
      selfRole: "VIEWER",
    });

    const result = await h.service.resolve({
      authorizationHeader: null,
      platformToken: "signed-session",
      requestedSessionId: "session-1",
    });

    expect(result).toEqual({
      ok: true,
      principal: expect.objectContaining({
        scopes: ["workflow:read", "session:trace"],
        capabilities: {
          scriptDepth: 1,
          teamId: null,
          teamRole: "none",
        },
      }),
    });
    expect(h.teamMembers.getMemberBySession).not.toHaveBeenCalled();
  });

  it("rejects inactive or missing workspace membership", async () => {
    h.data.hasActiveWorkspaceProjectMembership.mockResolvedValueOnce(false);

    await expect(
      h.service.resolve({
        authorizationHeader: null,
        platformToken: "signed-session",
        requestedSessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "workspace_membership_required",
      }),
    );

    h.data.getWorkspaceProjectMembershipDetail.mockResolvedValueOnce({
      ...workspace,
      selfRole: null,
    });
    await expect(
      h.service.resolve({
        authorizationHeader: null,
        platformToken: "signed-session",
        requestedSessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        code: "workspace_membership_required",
      }),
    );
  });

  it("drops stale team capabilities and rejects finalized sessions", async () => {
    h.teamMembers.getMemberBySession.mockResolvedValueOnce(null);
    const staleTeam = await h.service.resolve({
      authorizationHeader: null,
      platformToken: "signed-session",
      requestedSessionId: "session-1",
    });
    expect(staleTeam).toEqual({
      ok: true,
      principal: expect.objectContaining({
        capabilities: {
          scriptDepth: 1,
          teamId: null,
          teamRole: "none",
        },
      }),
    });

    h.data.getSessionFileOwner.mockResolvedValueOnce({
      id: "session-1",
      userId: "user-1",
      projectId: "project-1",
      status: "failed",
      completedAt: new Date("2026-07-18T12:00:00.000Z"),
    });
    await expect(
      h.service.resolve({
        authorizationHeader: null,
        platformToken: "signed-session",
        requestedSessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        code: "platform_session_inactive",
      }),
    );
  });

  it("does not treat a raw session ID as a credential", async () => {
    await expect(
      h.service.resolve({
        authorizationHeader: null,
        platformToken: "",
        requestedSessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 401,
        code: "workflow_mcp_auth_required",
      }),
    );
  });
});
