import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationTeamMemberLaunchService,
  buildTeamMemberRevivalPrompt,
  canonicalTeamMemberIdentity,
  createTeamMemberSessionId,
} from "$lib/server/application/team-member-launch";
import type {
  SessionLifecycleController,
  TeamMemberPeerDispatchRecipe,
  TeamMemberRow,
  TeamStore,
} from "$lib/server/application/ports";
import type { ApplicationPeerSessionSpawnService } from "$lib/server/application/peer-session-spawn";
import type { ApplicationTeamMailboxEligibilityService } from "$lib/server/application/team-mailbox-eligibility";

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

function peerRequest(
  overrides: Partial<TeamMemberPeerDispatchRecipe["request"]> = {},
): TeamMemberPeerDispatchRecipe["request"] {
  return {
    sessionId: "child-1",
    peerAgentId: "agent-1",
    peerAgentVersion: 1,
    prompt: "Do the work",
    parentSessionId: "lead-1",
    title: "teammate:worker",
    skipSpawn: false,
    provisionSandbox: true,
    sandboxTemplate: null,
    ...overrides,
  };
}

function dispatchRecipe(
  requestOverrides: Partial<TeamMemberPeerDispatchRecipe["request"]> = {},
): TeamMemberPeerDispatchRecipe {
  return {
    version: 1,
    teamId: "team-1",
    principal: {
      ...principal,
      capabilities: { ...principal.capabilities },
    },
    request: peerRequest(requestOverrides),
  };
}

function dispatchIntent(
  requestOverrides: Partial<TeamMemberPeerDispatchRecipe["request"]> = {},
) {
  const request = peerRequest(requestOverrides);
  return {
    prompt: request.prompt,
    title: request.title,
    skipSpawn: request.skipSpawn,
    provisionSandbox: request.provisionSandbox,
    sandboxTemplate: request.sandboxTemplate,
  };
}

const startingMember: TeamMemberRow = {
  id: "member-1",
  team_id: "team-1",
  session_id: "child-1",
  agent_slug: "worker",
  name: "worker",
  role: "member",
  model: null,
  status: "starting",
  plan_mode_required: false,
  joined_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
  launch_operation_id: "launch-1",
  launch_kind: "spawn",
  launch_started_at: "2026-07-21T00:00:00.000Z",
  launch_dispatch_recipe: dispatchRecipe(),
};

describe("createTeamMemberSessionId", () => {
  it("keeps a stable hash suffix within the Dapr instance ID limit", () => {
    const input = {
      teamId: `team-${"x".repeat(200)}`,
      name: `worker ${"y".repeat(200)}`,
    };
    const first = createTeamMemberSessionId(input);

    expect(first).toBe(createTeamMemberSessionId(input));
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first).toMatch(/^tm2-worker-y+-[0-9a-f]{24}$/);
    expect(
      createTeamMemberSessionId({ ...input, teamId: "other-team" }),
    ).not.toBe(first);
    expect(
      createTeamMemberSessionId({ ...input, previousSessionId: "old-1" }),
    ).not.toBe(first);
    expect(
      createTeamMemberSessionId({ ...input, previousSessionId: "old-2" }),
    ).not.toBe(
      createTeamMemberSessionId({ ...input, previousSessionId: "old-1" }),
    );
  });

  it("uses one canonical name for spawn identity and title", () => {
    expect(canonicalTeamMemberIdentity("  worker one  ")).toEqual({
      name: "worker one",
      title: "teammate:worker one",
    });
    expect(
      createTeamMemberSessionId({
        teamId: "team-1",
        name: "  worker one  ",
      }),
    ).toBe(createTeamMemberSessionId({ teamId: "team-1", name: "worker one" }));
    expect(canonicalTeamMemberIdentity("   ")).toBeNull();
  });

  it("keeps revival identity stable across surrounding name whitespace", () => {
    expect(
      createTeamMemberSessionId({
        teamId: "team-1",
        name: " worker ",
        previousSessionId: "old-1",
      }),
    ).toBe(
      createTeamMemberSessionId({
        teamId: "team-1",
        name: "worker",
        previousSessionId: "old-1",
      }),
    );
  });
});

describe("ApplicationTeamMemberLaunchService", () => {
  let teams: Pick<
    TeamStore,
    | "beginMemberSpawn"
    | "beginMemberRevival"
    | "findMemberSpawnReplay"
    | "findMemberRevivalReplay"
    | "promoteStartingMember"
    | "requestMemberLaunchCleanup"
    | "completeMemberLaunchCleanup"
  >;
  let peers: Pick<ApplicationPeerSessionSpawnService, "spawnPeerSession">;
  let lifecycle: Pick<SessionLifecycleController, "stopSession">;
  let eligibility: Pick<
    ApplicationTeamMailboxEligibilityService,
    "checkParticipants"
  >;
  let service: ApplicationTeamMemberLaunchService;

  beforeEach(() => {
    teams = {
      beginMemberSpawn: vi.fn(async () => ({
        member: startingMember,
        state: "acquired" as const,
        dispatchRecipe: dispatchRecipe(),
      })),
      beginMemberRevival: vi.fn(async () => ({
        member: {
          ...startingMember,
          launch_kind: "revival" as const,
          launch_previous_session_id: "old-1",
          launch_previous_status: "shutdown" as const,
        },
        state: "acquired" as const,
        dispatchRecipe: dispatchRecipe(),
      })),
      findMemberSpawnReplay: vi.fn(async () => null),
      findMemberRevivalReplay: vi.fn(async () => null),
      promoteStartingMember: vi.fn(async () => true),
      requestMemberLaunchCleanup: vi.fn(async () => ({
        action: "purge" as const,
      })),
      completeMemberLaunchCleanup: vi.fn(async () => true),
    };
    peers = {
      spawnPeerSession: vi.fn(async () => ({
        status: "ok" as const,
        body: { sessionId: "child-1", reused: false },
      })),
    };
    lifecycle = {
      stopSession: vi.fn(async () => ({
        confirmed: true,
        state: "confirmed",
      })),
    };
    eligibility = {
      checkParticipants: vi.fn(async () => ({
        status: "ok" as const,
        runtimeId: "dapr-agent-py",
        agentVersion: 1,
      })),
    };
    service = new ApplicationTeamMemberLaunchService({
      teams,
      peers,
      lifecycle,
      eligibility,
    });
  });

  it("reserves a new member as starting before dispatch and promotes afterward", async () => {
    const reservation = {
      teamId: "team-1",
      sessionId: "child-1",
      name: "worker",
      agentSlug: "worker",
    };
    const request = peerRequest();

    await expect(
      service.startNewMember({
        reservation,
        agentId: "agent-1",
        agentVersion: 1,
        peerRequest: request,
        principal,
      }),
    ).resolves.toEqual({
      status: "ok",
      member: { ...startingMember, status: "working" },
      spawn: {
        status: "ok",
        body: { sessionId: "child-1", reused: false },
      },
    });

    expect(teams.beginMemberSpawn).toHaveBeenCalledWith({
      ...reservation,
      dispatchRecipe: dispatchRecipe(),
    });
    expect(peers.spawnPeerSession).toHaveBeenCalledWith(request, principal, {
      kind: "team",
      teamId: "team-1",
    });
    expect(teams.promoteStartingMember).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(
      vi.mocked(teams.beginMemberSpawn).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(peers.spawnPeerSession).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(peers.spawnPeerSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(teams.promoteStartingMember).mock.invocationCallOrder[0],
    );
  });

  it("resumes an exact working spawn after its success response was lost", async () => {
    vi.mocked(teams.beginMemberSpawn).mockResolvedValueOnce({
      member: {
        ...startingMember,
        status: "working",
        launch_completed_at: "2026-07-21T00:01:00.000Z",
      },
      state: "active",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "ok",
      body: { sessionId: "child-1", reused: true },
    });

    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toMatchObject({
      status: "ok",
      member: { id: "member-1", status: "working" },
      spawn: { status: "ok", body: { reused: true } },
    });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("redrives a persisted recipe after a crash immediately after reservation", async () => {
    const stored = dispatchRecipe({ prompt: "Persisted prompt" });
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: {
        ...startingMember,
        launch_dispatch_recipe: stored,
      },
      state: "reserved",
      dispatchRecipe: stored,
    });

    const result = await service.inspectNewMemberReplay(
      {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
        agentSlug: "worker",
      },
      principal,
      dispatchIntent({ prompt: "Persisted prompt" }),
    );

    expect(result).toMatchObject({
      status: "ok",
      member: { status: "working" },
    });
    expect(peers.spawnPeerSession).toHaveBeenCalledWith(
      stored.request,
      principal,
      { kind: "team", teamId: "team-1" },
    );
    expect(eligibility.checkParticipants).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
  });

  it("compensates and propagates a deterministic 409 during persisted redrive", async () => {
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: startingMember,
      state: "in_flight",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      message: "parent session is stopped",
    });

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        principal,
        dispatchIntent(),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "parent session is stopped",
    });
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledOnce();
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "persisted teammate peer dispatch failed",
      graceMs: 0,
    });
  });

  it("returns a synthetic success for an already-active durable receipt", async () => {
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: { ...startingMember, status: "working" },
      state: "active",
      dispatchRecipe: dispatchRecipe(),
    });

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        principal,
        dispatchIntent(),
      ),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: {
        status: "ok",
        httpStatus: 200,
        body: { reused: true, pending: false },
      },
    });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
  });

  it("recognizes a concurrent promotion instead of compensating its child", async () => {
    const reserved = {
      member: startingMember,
      state: "reserved" as const,
      dispatchRecipe: dispatchRecipe(),
    };
    vi.mocked(teams.findMemberSpawnReplay)
      .mockResolvedValueOnce(reserved)
      .mockResolvedValueOnce({
        ...reserved,
        member: { ...startingMember, status: "working" },
        state: "active",
      });
    vi.mocked(teams.promoteStartingMember).mockResolvedValueOnce(false);

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        principal,
        dispatchIntent(),
      ),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 200, body: { pending: false } },
    });
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("rejects replay when the current authorized principal differs from the recipe", async () => {
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: startingMember,
      state: "reserved",
      dispatchRecipe: dispatchRecipe(),
    });

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        { ...principal, userId: "different-user" },
        dispatchIntent(),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 403,
      message:
        "teammate replay principal does not match the durable launch recipe",
    });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
  });

  it("rejects a same-name spawn replay when the dispatch payload changed", async () => {
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: startingMember,
      state: "reserved",
      dispatchRecipe: dispatchRecipe(),
    });

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        principal,
        dispatchIntent({ prompt: "Different work" }),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "teammate replay request does not match the durable launch recipe",
    });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
  });

  it("rejects a revival replay when the lead changed its instruction", async () => {
    const stored = dispatchRecipe({
      prompt: buildTeamMemberRevivalPrompt({
        name: "worker",
        previousSessionId: "old-1",
        previousStatus: "shutdown",
        prompt: "Original instruction",
      }),
    });
    vi.mocked(teams.findMemberRevivalReplay).mockResolvedValueOnce({
      member: {
        ...startingMember,
        launch_kind: "revival",
        launch_previous_session_id: "old-1",
        launch_previous_status: "shutdown",
        launch_dispatch_recipe: stored,
      },
      state: "reserved",
      dispatchRecipe: stored,
    });

    await expect(
      service.inspectMemberRevivalReplay(
        { teamId: "team-1", name: "worker", prompt: "Changed instruction" },
        principal,
      ),
    ).resolves.toMatchObject({ status: "error", httpStatus: 409 });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
  });

  it("compensates a persisted replay after a definitive peer rejection", async () => {
    vi.mocked(teams.findMemberSpawnReplay).mockResolvedValueOnce({
      member: startingMember,
      state: "reserved",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });

    await expect(
      service.inspectNewMemberReplay(
        { teamId: "team-1", sessionId: "child-1", name: "worker" },
        principal,
        dispatchIntent(),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "persisted teammate peer dispatch failed",
      graceMs: 0,
    });
  });

  it("compensates and propagates a deterministic first-owner 409", async () => {
    vi.mocked(teams.beginMemberSpawn).mockResolvedValueOnce({
      member: startingMember,
      state: "acquired",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      message: "session stopped before runtime attach",
    });

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "session stopped before runtime attach",
    });
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledOnce();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "teammate peer dispatch failed",
      graceMs: 0,
    });
  });

  it("does not dispatch when the starting reservation loses its fence", async () => {
    vi.mocked(teams.beginMemberSpawn).mockResolvedValueOnce(null);

    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        httpStatus: 409,
      }),
    );
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
  });

  it("rejects a peer-request version mismatch before eligibility or reservation", async () => {
    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest({ peerAgentVersion: 2 }),
      principal,
    });

    expect(result).toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "team member dispatch agent/version does not match its eligibility check",
    });
    expect(eligibility.checkParticipants).not.toHaveBeenCalled();
    expect(teams.beginMemberSpawn).not.toHaveBeenCalled();
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
  });

  it("rejects an eligibility result that changed version before reservation", async () => {
    vi.mocked(eligibility.checkParticipants).mockResolvedValueOnce({
      status: "ok",
      runtimeId: "dapr-agent-py",
      agentVersion: 2,
    });

    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toEqual({
      status: "error",
      httpStatus: 409,
      message: "team member agent version changed before launch reservation",
    });
    expect(teams.beginMemberSpawn).not.toHaveBeenCalled();
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
  });

  it("rejects an unsupported runtime before reserving membership or producing effects", async () => {
    vi.mocked(eligibility.checkParticipants).mockResolvedValueOnce({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });

    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "agent runtime 'claude-agent-py' does not support durable team mailbox receipts",
    });
    expect(eligibility.checkParticipants).toHaveBeenCalledWith({
      leadSessionId: "lead-1",
      memberAgentId: "agent-1",
      memberAgentVersion: 1,
    });
    expect(teams.beginMemberSpawn).not.toHaveBeenCalled();
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("rejects revival before changing a terminal member when eligibility fails", async () => {
    vi.mocked(eligibility.checkParticipants).mockResolvedValueOnce({
      status: "error",
      httpStatus: 409,
      message:
        "session runtime 'codex-cli' does not support durable team mailbox receipts",
    });

    const result = await service.reviveMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        memberId: "member-1",
        previousSessionId: "old-1",
        previousStatus: "shutdown",
        sessionId: "child-1",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toEqual(
      expect.objectContaining({ status: "error", httpStatus: 409 }),
    );
    expect(teams.beginMemberRevival).not.toHaveBeenCalled();
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("compensates a deterministically rejected dispatch", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "teammate peer dispatch failed",
      graceMs: 0,
    });
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(
      vi.mocked(teams.requestMemberLaunchCleanup).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(lifecycle.stopSession).mock.invocationCallOrder[0],
    );
    expect(
      vi.mocked(lifecycle.stopSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(teams.completeMemberLaunchCleanup).mock.invocationCallOrder[0],
    );
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
  });

  it("retains retry authority when the first-owner dispatch throws", async () => {
    vi.mocked(peers.spawnPeerSession).mockRejectedValueOnce(
      new Error("transport failed"),
    );

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
  });

  it("rejects a reservation race owned by a different agent generation", async () => {
    vi.mocked(teams.beginMemberSpawn).mockResolvedValueOnce({
      member: startingMember,
      state: "reserved",
      dispatchRecipe: dispatchRecipe({ peerAgentVersion: 2 }),
    });

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "teammate replay request does not match the durable launch recipe",
    });
    expect(peers.spawnPeerSession).not.toHaveBeenCalled();
  });

  it("retains retry authority for an ambiguous first-owner peer response", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 503,
      message: "upstream response was lost",
    });

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("retains retry authority when first-owner provisioning is already in progress", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "pending",
      httpStatus: 202,
      code: "runtime_provisioning",
      message: "runtime provisioning is already in progress",
      body: { sessionId: "child-1", reused: true, pending: true },
    });

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("retains the durable cleanup fence while purge is unconfirmed", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      state: "stopping",
      retryable: true,
    });

    await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledOnce();
    expect(lifecycle.stopSession).toHaveBeenCalledOnce();
    expect(teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
  });

  it("unwinds an unowned child reservation without a lifecycle stop", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    vi.mocked(teams.requestMemberLaunchCleanup).mockResolvedValueOnce({
      action: "unwind",
    });

    await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(lifecycle.stopSession).not.toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
  });

  it("completes exact cleanup when lifecycle proves the child absent", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      notFound: true,
      state: "not_found",
    });

    await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
  });

  it("does not purge when the exact cleanup fence cannot be persisted", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    vi.mocked(teams.requestMemberLaunchCleanup).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(lifecycle.stopSession).not.toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
  });

  it("keeps cleanup durable when exact finalization is unavailable", async () => {
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch rejected",
    });
    vi.mocked(teams.completeMemberLaunchCleanup).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      service.startNewMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          sessionId: "child-1",
          name: "worker",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({ status: "error", httpStatus: 422 });
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledOnce();
    expect(lifecycle.stopSession).toHaveBeenCalledOnce();
    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalledOnce();
  });

  it("compensates a dispatched child when promotion no longer proves ownership", async () => {
    vi.mocked(teams.promoteStartingMember).mockResolvedValueOnce(false);

    const result = await service.startNewMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        sessionId: "child-1",
        name: "worker",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "error",
        httpStatus: 409,
      }),
    );
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "teammate ownership changed during peer dispatch",
      graceMs: 0,
    });
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalled();
  });

  it("reserves a revival mapping before dispatch and restores its predecessor on failure", async () => {
    const reservation = {
      teamId: "team-1",
      memberId: "member-1",
      previousSessionId: "old-1",
      previousStatus: "shutdown" as const,
      sessionId: "child-1",
    };
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "error",
      httpStatus: 422,
      message: "dispatch failed",
    });

    await service.reviveMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation,
      peerRequest: peerRequest(),
      principal,
    });

    expect(teams.beginMemberRevival).toHaveBeenCalledWith({
      ...reservation,
      dispatchRecipe: dispatchRecipe(),
    });
    expect(
      vi.mocked(teams.beginMemberRevival).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(peers.spawnPeerSession).mock.invocationCallOrder[0],
    );
    expect(teams.requestMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "teammate revival peer dispatch failed",
      graceMs: 0,
    });
  });

  it("promotes a safely dispatched revival and keeps its predecessor terminal", async () => {
    const result = await service.reviveMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        memberId: "member-1",
        previousSessionId: "old-1",
        previousStatus: "failed",
        sessionId: "child-1",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result.status).toBe("ok");
    expect(teams.promoteStartingMember).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("resumes an exact working revival after its success response was lost", async () => {
    vi.mocked(teams.beginMemberRevival).mockResolvedValueOnce({
      member: {
        ...startingMember,
        status: "working",
        launch_kind: "revival",
        launch_previous_session_id: "old-1",
        launch_previous_status: "shutdown",
        launch_completed_at: "2026-07-21T00:01:00.000Z",
      },
      state: "active",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "ok",
      body: { sessionId: "child-1", reused: true },
    });

    const result = await service.reviveMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation: {
        teamId: "team-1",
        memberId: "member-1",
        previousSessionId: "old-1",
        previousStatus: "shutdown",
        sessionId: "child-1",
      },
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toMatchObject({
      status: "ok",
      member: { id: "member-1", status: "working" },
      spawn: { status: "ok", body: { reused: true } },
    });
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("does not compensate an exact revival replay while its original dispatch is in flight", async () => {
    vi.mocked(teams.beginMemberRevival).mockResolvedValueOnce({
      member: {
        ...startingMember,
        launch_kind: "revival",
        launch_previous_session_id: "old-1",
        launch_previous_status: "shutdown",
      },
      state: "reserved",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockRejectedValueOnce(
      new Error("original dispatch still owns provisioning"),
    );

    await expect(
      service.reviveMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          memberId: "member-1",
          previousSessionId: "old-1",
          previousStatus: "shutdown",
          sessionId: "child-1",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202 },
    });
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("does not compensate a revival when peer provisioning is already in progress", async () => {
    vi.mocked(teams.beginMemberRevival).mockResolvedValueOnce({
      member: {
        ...startingMember,
        launch_kind: "revival",
        launch_previous_session_id: "old-1",
        launch_previous_status: "shutdown",
      },
      state: "reserved",
      dispatchRecipe: dispatchRecipe(),
    });
    vi.mocked(peers.spawnPeerSession).mockResolvedValueOnce({
      status: "pending",
      httpStatus: 202,
      code: "runtime_provisioning",
      message: "runtime provisioning is already in progress",
      body: { sessionId: "child-1", reused: true, pending: true },
    });

    await expect(
      service.reviveMember({
        agentId: "agent-1",
        agentVersion: 1,
        reservation: {
          teamId: "team-1",
          memberId: "member-1",
          previousSessionId: "old-1",
          previousStatus: "shutdown",
          sessionId: "child-1",
        },
        peerRequest: peerRequest(),
        principal,
      }),
    ).resolves.toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(teams.promoteStartingMember).not.toHaveBeenCalled();
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("retains a revival recipe when the promotion response is lost", async () => {
    vi.mocked(teams.promoteStartingMember).mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    const reservation = {
      teamId: "team-1",
      memberId: "member-1",
      previousSessionId: "old-1",
      previousStatus: "shutdown" as const,
      sessionId: "child-1",
    };

    const result = await service.reviveMember({
      agentId: "agent-1",
      agentVersion: 1,
      reservation,
      peerRequest: peerRequest(),
      principal,
    });

    expect(result).toMatchObject({
      status: "ok",
      spawn: { status: "ok", httpStatus: 202, body: { pending: true } },
    });
    expect(teams.requestMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });
});
