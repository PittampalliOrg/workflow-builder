import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationTeamActionAuthorizationService,
  WORKFLOW_TEAM_SCRIPT_SYSTEM_PRINCIPAL,
} from "./team-action-authorization";
import type { ApplicationInternalWorkflowPrincipalService } from "./internal-workflow-principal";

const leadPrincipal = {
  userId: "user-1",
  projectId: "project-1",
  sessionId: "lead-1",
  scopes: ["session:team"],
  capabilities: {
    scriptDepth: 0,
    teamId: "team-lead-1",
    teamRole: "lead" as const,
  },
};

function harness() {
  const authorize = vi.fn<
    ApplicationInternalWorkflowPrincipalService["authorize"]
  >(async () => ({ ok: true, principal: leadPrincipal }));
  const getTeam = vi.fn(async () => null as any);
  const getMemberBySession = vi.fn(async () => null as any);
  const getSessionUserId = vi.fn(async () => "user-1" as string | null);
  const getSessionProjectId = vi.fn(async () => "project-1" as string | null);
  const service = new ApplicationTeamActionAuthorizationService({
    workflowPrincipals: { authorize },
    teams: {
      getTeam,
      getMemberBySession,
      getSessionUserId,
      getSessionProjectId,
    },
  });
  return {
    service,
    authorize,
    getTeam,
    getMemberBySession,
    getSessionUserId,
    getSessionProjectId,
  };
}

describe("ApplicationTeamActionAuthorizationService", () => {
  let h: ReturnType<typeof harness>;

  beforeEach(() => {
    h = harness();
  });

  it("authorizes only the exact signed initial lead team", async () => {
    await expect(
      h.service.authorizeUser({
        assertionToken: "signed",
        sessionId: "lead-1",
        teamId: "team-lead-1",
        requiredRole: "lead",
        allowUnformedLeadTeam: true,
      }),
    ).resolves.toEqual({ ok: true, principal: leadPrincipal, lane: "user" });
    expect(h.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        assertionToken: "signed",
        sessionId: "lead-1",
        requiredScope: "session:team",
      }),
    );

    await expect(
      h.service.authorizeUser({
        assertionToken: "signed",
        sessionId: "lead-1",
        teamId: "team-forged",
        requiredRole: "lead",
        allowUnformedLeadTeam: true,
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });

  it("revalidates a signed member against live team membership", async () => {
    const memberPrincipal = {
      ...leadPrincipal,
      sessionId: "member-1",
      capabilities: {
        scriptDepth: 0,
        teamId: "team-1",
        teamRole: "member" as const,
      },
    };
    h.authorize.mockResolvedValueOnce({
      ok: true,
      principal: memberPrincipal,
    });
    h.getTeam.mockResolvedValueOnce({
      id: "team-1",
      name: "Team",
      status: "active",
      lead_session_id: "lead-1",
      token_budget: null,
    });
    h.getMemberBySession.mockResolvedValueOnce({
      id: "member-row-1",
      team_id: "team-1",
      session_id: "member-1",
      agent_slug: "worker",
      name: "worker",
      role: "member",
      model: null,
      status: "working",
      plan_mode_required: false,
      joined_at: "2026-07-18T00:00:00Z",
      updated_at: "2026-07-18T00:00:00Z",
    });

    await expect(
      h.service.authorizeUser({
        assertionToken: "signed-member",
        sessionId: "member-1",
        teamId: "team-1",
      }),
    ).resolves.toEqual({
      ok: true,
      principal: memberPrincipal,
      lane: "user",
    });
  });

  it("rejects member capabilities for lead-only actions", async () => {
    h.authorize.mockResolvedValueOnce({
      ok: true,
      principal: {
        ...leadPrincipal,
        sessionId: "member-1",
        capabilities: {
          scriptDepth: 0,
          teamId: "team-1",
          teamRole: "member" as const,
        },
      },
    });
    await expect(
      h.service.authorizeUser({
        assertionToken: "signed-member",
        sessionId: "member-1",
        teamId: "team-1",
        requiredRole: "lead",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });

  it("keeps the workflow orchestrator system lane explicit and DB-bound", async () => {
    h.getTeam.mockResolvedValue({
      id: "team-run-1",
      name: "Script team",
      status: "active",
      lead_session_id: "script-lead-1",
      token_budget: null,
    });

    await expect(
      h.service.authorizeSystem({
        systemPrincipal: WORKFLOW_TEAM_SCRIPT_SYSTEM_PRINCIPAL,
        teamId: "team-run-1",
        sessionId: "script-lead-1",
        requiredRole: "lead",
      }),
    ).resolves.toEqual({
      ok: true,
      lane: "system",
      principal: {
        userId: "user-1",
        projectId: "project-1",
        sessionId: "script-lead-1",
        scopes: ["session:team"],
        capabilities: {
          scriptDepth: 0,
          teamId: "team-run-1",
          teamRole: "lead",
        },
      },
    });

    await expect(
      h.service.authorizeSystem({
        systemPrincipal: "workflow-mcp-server",
        teamId: "team-run-1",
        sessionId: "script-lead-1",
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: false, status: 403 }));
  });
});
