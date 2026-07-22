import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamMemberSessionId } from "$lib/server/application/team-member-launch";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getTeam: vi.fn(),
  getMemberByName: vi.fn(),
  getSessionProjectId: vi.fn(),
  resolveAgentIdBySlug: vi.fn(),
  getTeamBudget: vi.fn(),
  inspectMemberRevivalReplay: vi.fn(),
  reviveMember: vi.fn(),
  checkParticipants: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    teamStore: {
      getTeam: mocks.getTeam,
      getMemberByName: mocks.getMemberByName,
      getSessionProjectId: mocks.getSessionProjectId,
      resolveAgentIdBySlug: mocks.resolveAgentIdBySlug,
    },
    teamMemberLaunch: {
      inspectMemberRevivalReplay: mocks.inspectMemberRevivalReplay,
      reviveMember: mocks.reviveMember,
    },
    teamMailboxEligibility: { checkParticipants: mocks.checkParticipants },
  }),
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

const member = {
  id: "member-1",
  team_id: "team-1",
  session_id: "old-1",
  agent_slug: "worker",
  name: "worker-one",
  role: "member",
  model: null,
  status: "shutdown",
  plan_mode_required: false,
};

function event(body: Record<string, unknown> = {}) {
  return {
    params: { teamId: "team-1" },
    request: new Request(
      "http://workflow-builder/api/internal/team/team-1/revive",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requestedBySessionId: "lead-1",
          name: "worker-one",
          prompt: "Resume carefully",
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

describe("team revive route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({ ok: true, principal });
    mocks.getTeam.mockResolvedValue({ lead_session_id: "lead-1" });
    mocks.getMemberByName.mockResolvedValue(member);
    mocks.getSessionProjectId.mockResolvedValue("project-1");
    mocks.resolveAgentIdBySlug.mockResolvedValue({ id: "agent-1" });
    mocks.checkParticipants.mockResolvedValue({
      status: "ok",
      runtimeId: "dapr-agent-py",
      agentVersion: 7,
    });
    mocks.inspectMemberRevivalReplay.mockResolvedValue(null);
    mocks.getTeamBudget.mockResolvedValue({ exhausted: false });
    mocks.reviveMember.mockResolvedValue({
      status: "ok",
      member: { ...member, session_id: "replacement", status: "working" },
      spawn: {
        status: "ok",
        body: {
          sessionId: "replacement",
          workflowMcpSessionToken: "runtime-secret",
        },
      },
    });
  });

  it("reserves the exact terminal predecessor before peer revival dispatch", async () => {
    const sessionId = createTeamMemberSessionId({
      teamId: "team-1",
      name: "worker-one",
      previousSessionId: "old-1",
    });

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.inspectMemberRevivalReplay).toHaveBeenCalledWith(
      { teamId: "team-1", name: "worker-one", prompt: "Resume carefully" },
      principal,
    );
    expect(mocks.reviveMember).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentVersion: 7,
      reservation: {
        teamId: "team-1",
        memberId: "member-1",
        previousSessionId: "old-1",
        previousStatus: "shutdown",
        sessionId,
      },
      peerRequest: expect.objectContaining({
        sessionId,
        peerAgentId: "agent-1",
        peerAgentVersion: 7,
        parentSessionId: "lead-1",
        title: "teammate:worker-one",
        provisionSandbox: true,
      }),
      principal,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      name: "worker-one",
      sessionId,
      previousSessionId: "old-1",
      spawn: { sessionId: "replacement" },
    });
  });

  it("canonicalizes surrounding name whitespace before revival replay and launch", async () => {
    const sessionId = createTeamMemberSessionId({
      teamId: "team-1",
      name: "worker-one",
      previousSessionId: "old-1",
    });
    const response = (await POST(
      event({ name: "  worker-one  " }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.inspectMemberRevivalReplay).toHaveBeenCalledWith(
      { teamId: "team-1", name: "worker-one", prompt: "Resume carefully" },
      principal,
    );
    expect(mocks.getMemberByName).toHaveBeenCalledWith("team-1", "worker-one");
    expect(mocks.reviveMember).toHaveBeenCalledWith(
      expect.objectContaining({
        reservation: expect.objectContaining({ sessionId }),
        peerRequest: expect.objectContaining({
          title: "teammate:worker-one",
        }),
      }),
    );
  });

  it("rejects a whitespace-only revival name before replay", async () => {
    expect(await responseStatus(POST(event({ name: "  " }) as never))).toBe(
      400,
    );
    expect(mocks.inspectMemberRevivalReplay).not.toHaveBeenCalled();
    expect(mocks.reviveMember).not.toHaveBeenCalled();
  });

  it("surfaces a lost revival fence instead of reporting a working member", async () => {
    mocks.reviveMember.mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      message: "teammate changed state",
    });

    expect(await responseStatus(POST(event() as never))).toBe(409);
  });

  it("resumes the exact working revival after its success response was lost", async () => {
    mocks.inspectMemberRevivalReplay.mockResolvedValueOnce({
      status: "ok",
      member: {
        ...member,
        session_id: "replacement-1",
        status: "working",
        launch_previous_session_id: "old-1",
      },
      spawn: {
        status: "ok",
        body: { sessionId: "replacement-1", reused: true, pending: false },
      },
    });

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.getTeam).not.toHaveBeenCalled();
    expect(mocks.getMemberByName).not.toHaveBeenCalled();
    expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(mocks.checkParticipants).not.toHaveBeenCalled();
    expect(mocks.getTeamBudget).not.toHaveBeenCalled();
    expect(mocks.reviveMember).not.toHaveBeenCalled();
    expect(mocks.inspectMemberRevivalReplay).toHaveBeenCalledWith(
      { teamId: "team-1", name: "worker-one", prompt: "Resume carefully" },
      principal,
    );
  });

  it("returns accepted while durable revival redrive is still pending", async () => {
    mocks.inspectMemberRevivalReplay.mockResolvedValueOnce({
      status: "ok",
      member: { ...member, session_id: "replacement-1", status: "starting" },
      spawn: {
        status: "ok",
        httpStatus: 202,
        body: { sessionId: "replacement-1", reused: true, pending: true },
      },
    });

    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      spawn: { sessionId: "replacement-1", reused: true, pending: true },
    });
    expect(mocks.getTeam).not.toHaveBeenCalled();
    expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(mocks.reviveMember).not.toHaveBeenCalled();
  });

  it("surfaces a durable revival authority failure before catalog lookup", async () => {
    mocks.inspectMemberRevivalReplay.mockResolvedValueOnce({
      status: "error",
      httpStatus: 403,
      message: "teammate replay principal does not match",
    });

    expect(await responseStatus(POST(event() as never))).toBe(403);
    expect(mocks.getTeam).not.toHaveBeenCalled();
    expect(mocks.resolveAgentIdBySlug).not.toHaveBeenCalled();
    expect(mocks.reviveMember).not.toHaveBeenCalled();
  });

  it("rejects an unsupported replacement before reserving revival", async () => {
    mocks.checkParticipants.mockResolvedValueOnce({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });

    expect(await responseStatus(POST(event() as never))).toBe(400);
    expect(mocks.reviveMember).not.toHaveBeenCalled();
  });

  it("keeps dispatch, membership CAS, and child compensation behind the application service", () => {
    const source = readFileSync(
      join(import.meta.dirname, "+server.ts"),
      "utf8",
    );
    expect(source).toContain("teamMemberLaunch.reviveMember");
    expect(source).toContain("teamMailboxEligibility.checkParticipants");
    expect(source).not.toContain("peerSessionSpawn.spawnPeerSession");
    expect(source).not.toContain("setMemberSession");
    expect(source).not.toContain("sessionLifecycle.stopSession");
  });
});
