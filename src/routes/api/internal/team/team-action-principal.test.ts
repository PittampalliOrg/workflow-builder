import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validateInternalToken: vi.fn(() => true),
  authorizeUser: vi.fn(),
  authorizeSystem: vi.fn(),
}));

vi.mock("$lib/server/internal-auth", () => ({
  validateInternalToken: mocks.validateInternalToken,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    teamActionAuthorization: {
      authorizeUser: mocks.authorizeUser,
      authorizeSystem: mocks.authorizeSystem,
    },
  }),
}));

import {
  authorizeTeamActionRequest,
  publicPeerSpawnProjection,
} from "./team-action-principal";

function request(headers: Record<string, string>) {
  return new Request("http://workflow-builder/api/internal/team/team-1/tasks", {
    headers: { "X-Internal-Token": "internal", ...headers },
  });
}

describe("team action principal HTTP adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateInternalToken.mockReturnValue(true);
    mocks.authorizeUser.mockResolvedValue({
      ok: false,
      status: 403,
      error: "no",
    });
    mocks.authorizeSystem.mockResolvedValue({
      ok: false,
      status: 403,
      error: "no",
    });
  });

  it("maps signed user headers onto the application authorization use case", async () => {
    await authorizeTeamActionRequest(
      request({
        "X-Wfb-Principal-Assertion": "signed-principal",
        "X-Wfb-Session-Id": "session-1",
      }),
      "team-1",
      { bodySessionId: "session-1", requiredRole: "lead" },
    );

    expect(mocks.authorizeUser).toHaveBeenCalledWith({
      assertionToken: "signed-principal",
      platformToken: undefined,
      legacyUserId: undefined,
      legacyProjectId: undefined,
      teamId: "team-1",
      sessionId: "session-1",
      requiredRole: "lead",
      allowUnformedLeadTeam: undefined,
    });
    expect(mocks.authorizeSystem).not.toHaveBeenCalled();
  });

  it("retains the internal service credential gate", async () => {
    mocks.validateInternalToken.mockReturnValueOnce(false);
    await expect(
      authorizeTeamActionRequest(
        request({
          "X-Wfb-Principal-Assertion": "signed-principal",
          "X-Wfb-Session-Id": "session-1",
        }),
        "team-1",
      ),
    ).resolves.toEqual({ ok: false, status: 401, error: "Unauthorized" });
    expect(mocks.authorizeUser).not.toHaveBeenCalled();
    expect(mocks.authorizeSystem).not.toHaveBeenCalled();
  });

  it("rejects body identity that differs from signed session lineage", async () => {
    await expect(
      authorizeTeamActionRequest(
        request({
          "X-Wfb-Principal-Assertion": "signed-principal",
          "X-Wfb-Session-Id": "session-1",
        }),
        "team-1",
        { bodySessionId: "forged-session" },
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
    expect(mocks.authorizeUser).not.toHaveBeenCalled();
  });

  it("maps only the named system lane and keeps it separate from user claims", async () => {
    await authorizeTeamActionRequest(
      request({
        "X-Wfb-System-Principal": "workflow-orchestrator-team-script",
        "X-Wfb-Session-Id": "script-lead-1",
      }),
      "team-run-1",
      { requiredRole: "lead" },
    );
    expect(mocks.authorizeSystem).toHaveBeenCalledWith({
      systemPrincipal: "workflow-orchestrator-team-script",
      teamId: "team-run-1",
      sessionId: "script-lead-1",
      requiredRole: "lead",
    });

    await expect(
      authorizeTeamActionRequest(
        request({
          "X-Wfb-System-Principal": "workflow-orchestrator-team-script",
          "X-Wfb-Session-Id": "script-lead-1",
          "X-Wfb-Principal-Assertion": "signed-principal",
        }),
        "team-run-1",
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });

  it("never exposes the runtime child session credential in team results", () => {
    expect(
      publicPeerSpawnProjection({
        sessionId: "child-1",
        workflowMcpSessionToken: "runtime-secret",
        reused: false,
      }),
    ).toEqual({ sessionId: "child-1", reused: false });
  });
});
