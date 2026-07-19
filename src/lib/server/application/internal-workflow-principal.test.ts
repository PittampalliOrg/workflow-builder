import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationInternalWorkflowPrincipalService } from "./internal-workflow-principal";
import type { WorkflowMcpPrincipalResolutionResult } from "./workflow-mcp-principal";
import type {
  LegacyWorkflowRuntimeCompatibilityPolicy,
  LegacyWorkflowRuntimeResourceReader,
  WorkflowMcpPrincipalAssertionVerifier,
  WorkflowMcpSessionOwnerReader,
} from "./ports/workflow-mcp-auth";

const assertion = {
  userId: "user-1",
  projectId: "project-1",
  sessionId: null as string | null,
  scopes: ["workflow:execute", "workflow:write"],
  capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" as const },
};
const owner = {
  id: "session-1",
  userId: "user-1",
  projectId: "project-1",
};

function harness() {
  const verify = vi.fn<WorkflowMcpPrincipalAssertionVerifier["verify"]>(
    () => assertion,
  );
  const principalAssertions = { verify };
  const getSessionFileOwner = vi.fn<
    WorkflowMcpSessionOwnerReader["getSessionFileOwner"]
  >(async () => owner);
  const sessionOwners = {
    getSessionFileOwner,
  };
  const resolvePlatformPrincipal = vi.fn(
    async (): Promise<WorkflowMcpPrincipalResolutionResult> => ({
      ok: true,
      principal: {
        authMode: "platform_session",
        userId: "user-1",
        projectId: "project-1",
        workspace: { id: "project-1", slug: "demo", name: "Demo" },
        scopes: ["workflow:read", "workflow:execute"],
        sessionId: "session-1",
        capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
        principalAssertion: "signed-platform-principal",
      },
    }),
  );
  const platformPrincipals = { resolve: resolvePlatformPrincipal };
  const legacyResources: LegacyWorkflowRuntimeResourceReader = {
    getSessionFileOwner,
    getWorkflowExecutionOwner: vi.fn(async (executionId) => ({
      id: executionId,
      userId: "user-1",
      projectId: "project-1",
    })),
    getWorkspaceProjectMembershipDetail: vi.fn(async () => ({
      id: "project-1",
      displayName: "Demo",
      externalId: "demo",
      selfRole: "ADMIN",
    })),
    hasActiveWorkspaceProjectMembership: vi.fn(async () => true),
  };
  const legacyPolicy: LegacyWorkflowRuntimeCompatibilityPolicy = {
    isEnabled: vi.fn(() => false),
  };
  return {
    principalAssertions,
    sessionOwners,
    platformPrincipals,
    legacyResources,
    legacyPolicy,
    service: new ApplicationInternalWorkflowPrincipalService({
      principalAssertions,
      sessionOwners,
      platformPrincipals,
      legacyResources,
      legacyPolicy,
    }),
  };
}

describe("ApplicationInternalWorkflowPrincipalService", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("authorizes a signed scoped principal without requiring a session", async () => {
    await expect(
      h.service.authorize({
        assertionToken: "signed",
        sessionId: null,
        requiredScope: "workflow:write",
      }),
    ).resolves.toEqual({ ok: true, principal: assertion });
    expect(h.sessionOwners.getSessionFileOwner).not.toHaveBeenCalled();
  });

  it("rejects unsigned headers, invalid assertions, and missing scopes", async () => {
    await expect(
      h.service.authorize({ legacyUserId: "user-2", sessionId: null }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 400 }));

    h.principalAssertions.verify.mockReturnValueOnce(null);
    await expect(
      h.service.authorize({ assertionToken: "bad", sessionId: null }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));

    await expect(
      h.service.authorize({
        assertionToken: "signed",
        sessionId: null,
        requiredScope: "agent:write",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });

  it("validates session lineage carried by a signed principal", async () => {
    h.principalAssertions.verify.mockReturnValueOnce({
      ...assertion,
      sessionId: "session-1",
    });
    await expect(
      h.service.authorize({
        assertionToken: "signed",
        sessionId: "session-1",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        principal: expect.objectContaining({ sessionId: "session-1" }),
      }),
    );
    expect(h.sessionOwners.getSessionFileOwner).toHaveBeenCalledWith(
      "session-1",
    );
  });

  it("rejects mismatched or finalized signed session lineage", async () => {
    h.principalAssertions.verify.mockReturnValue({
      ...assertion,
      sessionId: "session-1",
    });
    await expect(
      h.service.authorize({
        assertionToken: "signed",
        sessionId: "other-session",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));

    h.sessionOwners.getSessionFileOwner.mockResolvedValueOnce({
      ...owner,
      status: "failed",
      completedAt: new Date("2026-07-18T12:00:00.000Z"),
    });
    await expect(
      h.service.authorize({
        assertionToken: "signed",
        sessionId: "session-1",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });

  it("authorizes a signed platform session through the principal use case", async () => {
    await expect(
      h.service.authorize({
        platformToken: "signed-session",
        sessionId: "session-1",
        requiredScope: "workflow:execute",
      }),
    ).resolves.toEqual({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "session-1",
        scopes: ["workflow:read", "workflow:execute"],
        capabilities: { scriptDepth: 0, teamId: null, teamRole: "none" },
      },
    });
    expect(h.platformPrincipals.resolve).toHaveBeenCalledWith({
      authorizationHeader: null,
      platformToken: "signed-session",
      requestedSessionId: "session-1",
    });
  });

  it("does not accept a raw session id as authorization", async () => {
    await expect(
      h.service.authorize({ sessionId: "session-1" }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 400 }));
    expect(h.sessionOwners.getSessionFileOwner).not.toHaveBeenCalled();
  });

  it("allows only explicitly enabled, server-resolved legacy resources", async () => {
    vi.mocked(h.legacyPolicy.isEnabled).mockReturnValue(true);
    await expect(
      h.service.authorize({
        sessionId: "session-1",
        requiredScope: "workflow:execute",
        legacyResource: { kind: "session", id: "session-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "session-1",
        scopes: ["workflow:execute"],
        capabilities: {
          scriptDepth: 1,
          teamId: null,
          teamRole: "none",
        },
      },
    });
    await expect(
      h.service.authorize({
        sessionId: null,
        requiredScope: "workflow:read",
        legacyResource: {
          kind: "workflow_execution",
          id: "execution-1",
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      principal: { sessionId: null, scopes: ["workflow:read"] },
    });
  });

  it("rejects disabled, terminal, mismatched, and underprivileged legacy sessions", async () => {
    const legacyInput = {
      sessionId: "session-1",
      requiredScope: "workflow:execute",
      legacyResource: { kind: "session" as const, id: "session-1" },
    };
    await expect(h.service.authorize(legacyInput)).resolves.toMatchObject({
      ok: false,
      status: 400,
    });

    vi.mocked(h.legacyPolicy.isEnabled).mockReturnValue(true);
    await expect(
      h.service.authorize({
        ...legacyInput,
        sessionId: "another-session",
      }),
    ).resolves.toMatchObject({ ok: false, status: 403 });

    h.sessionOwners.getSessionFileOwner.mockResolvedValueOnce({
      ...owner,
      status: "completed",
      completedAt: new Date(),
    });
    await expect(h.service.authorize(legacyInput)).resolves.toMatchObject({
      ok: false,
      status: 403,
    });

    vi.mocked(
      h.legacyResources.getWorkspaceProjectMembershipDetail,
    ).mockResolvedValueOnce({
      id: "project-1",
      displayName: "Demo",
      externalId: "demo",
      selfRole: "VIEWER",
    });
    await expect(h.service.authorize(legacyInput)).resolves.toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("never downgrades an invalid signed token into legacy compatibility", async () => {
    vi.mocked(h.legacyPolicy.isEnabled).mockReturnValue(true);
    h.platformPrincipals.resolve.mockResolvedValueOnce({
      ok: false,
      status: 401,
      code: "invalid_platform_session_token",
      error: "invalid",
    });
    await expect(
      h.service.authorize({
        platformToken: "bad-token",
        sessionId: "session-1",
        requiredScope: "workflow:execute",
        legacyResource: { kind: "session", id: "session-1" },
      }),
    ).resolves.toMatchObject({ ok: false, status: 403 });
    expect(h.legacyPolicy.isEnabled).not.toHaveBeenCalled();
  });
});
