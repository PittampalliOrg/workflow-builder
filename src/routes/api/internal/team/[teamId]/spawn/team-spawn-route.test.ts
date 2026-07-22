import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamMemberSessionId } from "$lib/server/application/team-member-launch";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  ensureTeam: vi.fn(),
  listMembers: vi.fn(),
  resolveAgentIdBySlug: vi.fn(),
  ensureTeamRunExecution: vi.fn(),
  getTeamBudget: vi.fn(),
  inspectNewMemberReplay: vi.fn(),
  startNewMember: vi.fn(),
  checkParticipants: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    teamMemberLaunch: {
      inspectNewMemberReplay: mocks.inspectNewMemberReplay,
      startNewMember: mocks.startNewMember,
    },
    teamMailboxEligibility: { checkParticipants: mocks.checkParticipants },
  }),
}));
vi.mock("$lib/server/teams/team-repo", () => ({
  ensureTeam: mocks.ensureTeam,
  listMembers: mocks.listMembers,
  resolveAgentIdBySlug: mocks.resolveAgentIdBySlug,
}));
vi.mock("$lib/server/teams/team-run", () => ({
  ensureTeamRunExecution: mocks.ensureTeamRunExecution,
}));
vi.mock("$lib/server/teams/team-budget", () => ({
  getTeamBudget: mocks.getTeamBudget,
}));
vi.mock("../../team-action-principal", () => ({
  authorizeTeamActionRequest: mocks.authorize,
  publicPeerSpawnProjection: (body: Record<string, unknown>) => {
    const result = { ...body };
    delete result.workflowMcpSessionToken;
    return result;
  },
}));

import { POST } from "./+server";

const principal = {
  userId: "user-1",
  projectId: "project-1",
  sessionId: "lead-1",
  capabilities: {
    scriptDepth: 0,
    teamId: "team-1",
    teamRole: "lead" as const,
  },
};

const teammateSessionId = createTeamMemberSessionId({
  teamId: "team-1",
  name: "worker-one",
});

function event(body: Record<string, unknown> = {}) {
  return {
    params: { teamId: "team-1" },
    request: new Request(
      "http://workflow-builder/api/internal/team/team-1/spawn",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leadSessionId: "lead-1",
          agentSlug: "worker",
          name: "worker-one",
          prompt: "Do the work",
          ...body,
        }),
      },
    ),
  };
}

async function responseStatus(value: unknown): Promise<number> {
  try {
    return ((await value) as Response).status;
  } catch (cause) {
    return (cause as { status?: number }).status ?? 500;
  }
}

describe("team spawn route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({ ok: true, principal });
    mocks.listMembers.mockResolvedValue([{ role: "lead" }]);
    mocks.getTeamBudget.mockResolvedValue({ exhausted: false });
    mocks.resolveAgentIdBySlug.mockResolvedValue({ id: "agent-1" });
    mocks.checkParticipants.mockResolvedValue({
      status: "ok",
      runtimeId: "dapr-agent-py",
      agentVersion: 7,
    });
    mocks.inspectNewMemberReplay.mockResolvedValue(null);
    mocks.startNewMember.mockResolvedValue({
      status: "ok",
      member: { name: "worker-one" },
      spawn: {
        status: "ok",
        body: {
          sessionId: teammateSessionId,
          workflowMcpSessionToken: "runtime-secret",
        },
      },
    });
  });

  it("delegates reservation, dispatch, and promotion to the application service", async () => {
    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.inspectNewMemberReplay).toHaveBeenCalledWith(
      {
        teamId: "team-1",
        sessionId: teammateSessionId,
        name: "worker-one",
        agentSlug: "worker",
        model: null,
        planModeRequired: false,
      },
      principal,
      {
        prompt: "Do the work",
        title: "teammate:worker-one",
        skipSpawn: false,
        provisionSandbox: true,
        sandboxTemplate: null,
      },
    );
    expect(mocks.startNewMember).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentVersion: 7,
      reservation: {
        teamId: "team-1",
        sessionId: teammateSessionId,
        name: "worker-one",
        agentSlug: "worker",
        model: null,
        planModeRequired: false,
      },
      peerRequest: {
        sessionId: teammateSessionId,
        peerAgentId: "agent-1",
        peerAgentVersion: 7,
        prompt: "Do the work",
        parentSessionId: "lead-1",
        title: "teammate:worker-one",
        skipSpawn: false,
        provisionSandbox: true,
        sandboxTemplate: null,
      },
      principal,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      name: "worker-one",
      sessionId: teammateSessionId,
      spawn: { sessionId: teammateSessionId },
    });
  });

  it("canonicalizes surrounding name whitespace before replay and launch", async () => {
    const response = (await POST(
      event({ name: "  worker-one  " }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.inspectNewMemberReplay).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "worker-one",
        sessionId: teammateSessionId,
      }),
      principal,
      expect.objectContaining({ title: "teammate:worker-one" }),
    );
    expect(mocks.startNewMember).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation: expect.objectContaining({
          name: "worker-one",
          sessionId: teammateSessionId,
        }),
        peerRequest: expect.objectContaining({
          title: "teammate:worker-one",
        }),
      }),
    );
  });

  it("rejects a whitespace-only member name before replay", async () => {
    expect(await responseStatus(POST(event({ name: "   " }) as never))).toBe(
      400,
    );
    expect(mocks.inspectNewMemberReplay).not.toHaveBeenCalled();
    expect(mocks.startNewMember).not.toHaveBeenCalled();
  });

  it("preserves the application service error and never reports a phantom member", async () => {
    mocks.startNewMember.mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      message: "member start lost its fence",
    });

    expect(await responseStatus(POST(event() as never))).toBe(409);
  });

  it("recovers from the durable recipe without consulting the mutable agent catalog", async () => {
    mocks.inspectNewMemberReplay.mockResolvedValueOnce({
      status: "ok",
      member: {
        name: "worker-one",
        session_id: teammateSessionId,
      },
      spawn: {
        status: "ok",
        body: {
          sessionId: teammateSessionId,
          reused: true,
          pending: false,
        },
      },
    });
    const previousCap = process.env.TEAM_MAX_MEMBERS;
    process.env.TEAM_MAX_MEMBERS = "2";

    try {
      const response = (await POST(event() as never)) as Response;
      expect(response.status).toBe(200);
      expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
      expect(mocks.checkParticipants).not.toHaveBeenCalled();
      expect(mocks.ensureTeam).not.toHaveBeenCalled();
      expect(mocks.listMembers).not.toHaveBeenCalled();
      expect(mocks.getTeamBudget).not.toHaveBeenCalled();
      expect(mocks.startNewMember).not.toHaveBeenCalled();
      expect(mocks.inspectNewMemberReplay).toHaveBeenCalledWith(
        expect.objectContaining({ agentSlug: "worker" }),
        principal,
        expect.objectContaining({ prompt: "Do the work" }),
      );
    } finally {
      if (previousCap === undefined) delete process.env.TEAM_MAX_MEMBERS;
      else process.env.TEAM_MAX_MEMBERS = previousCap;
    }
  });

  it("returns accepted when durable replay redrive remains concurrent", async () => {
    mocks.inspectNewMemberReplay.mockResolvedValueOnce({
      status: "ok",
      member: {
        name: "worker-one",
        session_id: teammateSessionId,
        status: "starting",
      },
      spawn: {
        status: "ok",
        httpStatus: 202,
        body: {
          sessionId: teammateSessionId,
          reused: true,
          pending: true,
        },
      },
    });

    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      sessionId: teammateSessionId,
      spawn: { reused: true, pending: true },
    });
    expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(mocks.startNewMember).not.toHaveBeenCalled();
  });

  it("surfaces a durable replay authority failure before catalog lookup", async () => {
    mocks.inspectNewMemberReplay.mockResolvedValueOnce({
      status: "error",
      httpStatus: 403,
      message: "teammate replay principal does not match",
    });

    expect(await responseStatus(POST(event() as never))).toBe(403);
    expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(mocks.startNewMember).not.toHaveBeenCalled();
  });

  it("rejects unsupported participants before forming a team or starting a run", async () => {
    mocks.checkParticipants.mockResolvedValueOnce({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });

    expect(await responseStatus(POST(event() as never))).toBe(400);

    expect(mocks.checkParticipants).toHaveBeenCalledWith({
      leadSessionId: "lead-1",
      memberAgentId: "agent-1",
    });
    expect(mocks.ensureTeam).not.toHaveBeenCalled();
    expect(mocks.ensureTeamRunExecution).not.toHaveBeenCalled();
    expect(mocks.startNewMember).not.toHaveBeenCalled();
  });

  it("does not bypass the team-member launch application boundary", () => {
    const source = readFileSync(
      join(import.meta.dirname, "+server.ts"),
      "utf8",
    );
    expect(source).toContain("teamMemberLaunch.startNewMember");
    expect(source).toContain("teamMailboxEligibility.checkParticipants");
    expect(source).not.toContain("peerSessionSpawn.spawnPeerSession");
    expect(source).not.toMatch(/\baddMember\s*\(/);
    expect(source).not.toContain("sessionLifecycle.stopSession");
  });
});
