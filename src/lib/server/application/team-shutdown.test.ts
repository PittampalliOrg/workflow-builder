import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationTeamShutdownService } from "$lib/server/application/team-shutdown";
import type {
  SessionLifecycleController,
  TeamMemberRow,
  TeamStore,
} from "$lib/server/application/ports";

const member: TeamMemberRow = {
  id: "member-1",
  team_id: "team-1",
  session_id: "session-1",
  agent_slug: "worker",
  name: "worker",
  role: "member",
  model: null,
  status: "working",
  plan_mode_required: false,
  joined_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
};

describe("ApplicationTeamShutdownService", () => {
  let teams: Pick<TeamStore, "getMemberByName" | "finalizeMemberShutdown">;
  let lifecycle: Pick<SessionLifecycleController, "stopSession">;
  let service: ApplicationTeamShutdownService;

  beforeEach(() => {
    teams = {
      getMemberByName: vi.fn(async () => member),
      finalizeMemberShutdown: vi.fn(async () => "updated" as const),
    };
    lifecycle = {
      stopSession: vi.fn(async () => ({
        confirmed: true,
        state: "confirmed",
      })),
    };
    service = new ApplicationTeamShutdownService({ teams, lifecycle });
  });

  it("writes the terminal member status only after durable confirmation", async () => {
    const result = await service.shutdownMember({
      teamId: "team-1",
      name: "worker",
    });

    expect(result).toEqual({
      status: "confirmed",
      name: "worker",
      stop: { confirmed: true, state: "confirmed" },
    });
    expect(lifecycle.stopSession).toHaveBeenCalledWith("session-1", {
      mode: "purge",
      reason: "team shutdown",
    });
    expect(teams.finalizeMemberShutdown).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "session-1",
    });
  });

  it("leaves the member non-terminal while the durable run is stopping", async () => {
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      state: "stopping",
    });

    await expect(
      service.shutdownMember({ teamId: "team-1", name: "worker" }),
    ).resolves.toEqual({
      status: "stopping",
      name: "worker",
      stop: { confirmed: false, state: "stopping" },
    });
    expect(teams.finalizeMemberShutdown).not.toHaveBeenCalled();
  });

  it("surfaces stop-intent persistence failure as unavailable", async () => {
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      notFound: false,
      requested: false,
      state: "stopping",
      retryable: true,
      steps: [],
    });

    await expect(
      service.shutdownMember({ teamId: "team-1", name: "worker" }),
    ).resolves.toEqual({
      status: "unavailable",
      message: "stop intent for teammate 'worker' could not be persisted",
    });
    expect(teams.finalizeMemberShutdown).not.toHaveBeenCalled();
  });

  it("fails closed for a partial result that claims a state without confirmation", async () => {
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      state: "confirmed",
    });

    const result = await service.shutdownMember({
      teamId: "team-1",
      name: "worker",
    });

    expect(result.status).toBe("stopping");
    expect(teams.finalizeMemberShutdown).not.toHaveBeenCalled();
  });

  it("does not write shutdown when the durable run is not found", async () => {
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      notFound: true,
      confirmed: false,
      state: "notFound",
    });

    const result = await service.shutdownMember({
      teamId: "team-1",
      name: "worker",
    });

    expect(result).toEqual({
      status: "not_found",
      message: "durable run for teammate 'worker' was not found",
      stop: { notFound: true, confirmed: false, state: "notFound" },
    });
    expect(teams.finalizeMemberShutdown).not.toHaveBeenCalled();
  });

  it("confirms replay when an already-terminal member session was purged", async () => {
    vi.mocked(teams.getMemberByName).mockResolvedValueOnce({
      ...member,
      status: "shutdown",
    });
    vi.mocked(lifecycle.stopSession).mockResolvedValueOnce({
      notFound: true,
      confirmed: false,
      state: "notFound",
    });

    await expect(
      service.shutdownMember({ teamId: "team-1", name: "worker" }),
    ).resolves.toEqual({
      status: "confirmed",
      name: "worker",
      terminalEvidence: "member_already_terminal",
    });
    expect(teams.finalizeMemberShutdown).not.toHaveBeenCalled();
  });

  it("rejects missing and lead members before touching lifecycle", async () => {
    vi.mocked(teams.getMemberByName).mockResolvedValueOnce(null);
    await expect(
      service.shutdownMember({ teamId: "team-1", name: "missing" }),
    ).resolves.toEqual({
      status: "not_found",
      message: "no teammate 'missing' in this team",
    });

    vi.mocked(teams.getMemberByName).mockResolvedValueOnce({
      ...member,
      role: "lead",
    });
    await expect(
      service.shutdownMember({ teamId: "team-1", name: "lead" }),
    ).resolves.toEqual({
      status: "invalid",
      message: "cannot shut down the team lead",
    });
    expect(lifecycle.stopSession).not.toHaveBeenCalled();
  });

  it("retries when revival changes the member session during lifecycle stop", async () => {
    vi.mocked(teams.finalizeMemberShutdown).mockResolvedValueOnce("stale");

    await expect(
      service.shutdownMember({ teamId: "team-1", name: "worker" }),
    ).resolves.toEqual({
      status: "stopping",
      name: "worker",
      stop: { confirmed: true, state: "confirmed" },
    });
  });

  it("treats an already-terminal exact member session as confirmed", async () => {
    vi.mocked(teams.finalizeMemberShutdown).mockResolvedValueOnce(
      "already_terminal",
    );

    const result = await service.shutdownMember({
      teamId: "team-1",
      name: "worker",
    });

    expect(result.status).toBe("confirmed");
  });
});
