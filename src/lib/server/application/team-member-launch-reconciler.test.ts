import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconcileTeamMemberLaunches,
  type TeamMemberLaunchReconcilerDeps,
} from "$lib/server/application/team-member-launch-reconciler";
import type { StaleTeamMemberLaunch } from "$lib/server/application/ports";

const now = Date.parse("2026-07-21T18:00:00.000Z");

function candidate(
  overrides: Partial<StaleTeamMemberLaunch> = {},
): StaleTeamMemberLaunch {
  return {
    memberId: "member-1",
    teamId: "team-1",
    sessionId: "child-1",
    operationId: "launch-1",
    kind: "spawn",
    startedAt: new Date(now - 120_000),
    cleanupRequestedAt: null,
    cleanupAction: null,
    previousSessionId: null,
    previousStatus: null,
    runtimeAppId: "agent-session-child-1-g1",
    daprInstanceId: "child-1--g1",
    runtimeProvisioningStartedAt: null,
    ...overrides,
  };
}

describe("reconcileTeamMemberLaunches", () => {
  let deps: TeamMemberLaunchReconcilerDeps;

  beforeEach(() => {
    deps = {
      teams: {
        listStaleMemberLaunches: vi.fn(async () => [candidate()]),
        reconcileStaleMemberLaunch: vi.fn(async () => ({
          status: "promoted" as const,
        })),
        completeMemberLaunchCleanup: vi.fn(async () => true),
      },
      lifecycle: {
        stopSession: vi.fn(async () => ({
          confirmed: true,
          state: "confirmed",
        })),
      },
      now: () => now,
    };
  });

  it("promotes a crash-stranded new spawn only through the exact generation proof", async () => {
    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(deps.teams.listStaleMemberLaunches).toHaveBeenCalledWith({
      staleBefore: new Date(now - 60_000),
      limit: 20,
    });
    expect(deps.teams.reconcileStaleMemberLaunch).toHaveBeenCalledWith(
      candidate(),
    );
    expect(deps.lifecycle.stopSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      scanned: 1,
      actionsTaken: 1,
      decisions: [{ action: "promoted", executed: true }],
    });
  });

  it("purges then exactly restores a crash-stranded revival predecessor", async () => {
    const revival = candidate({
      kind: "revival",
      previousSessionId: "old-child-1",
      previousStatus: "shutdown",
      runtimeAppId: null,
    });
    vi.mocked(deps.teams.listStaleMemberLaunches).mockResolvedValueOnce([
      revival,
    ]);
    vi.mocked(deps.teams.reconcileStaleMemberLaunch).mockResolvedValueOnce({
      status: "cleanup",
      action: "purge",
    });

    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(deps.lifecycle.stopSession).toHaveBeenCalledWith("child-1", {
      mode: "purge",
      reason: "Stale teammate revival launch launch-1",
      graceMs: 0,
    });
    expect(deps.teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(
      vi.mocked(deps.lifecycle.stopSession).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deps.teams.completeMemberLaunchCleanup).mock
        .invocationCallOrder[0],
    );
    expect(result.decisions[0]).toMatchObject({
      kind: "revival",
      action: "cleanup_completed",
      executed: true,
    });
  });

  it("retains the exact reservation until lifecycle purge is confirmed", async () => {
    vi.mocked(deps.teams.reconcileStaleMemberLaunch).mockResolvedValueOnce({
      status: "cleanup",
      action: "purge",
    });
    vi.mocked(deps.lifecycle.stopSession).mockResolvedValueOnce({
      confirmed: false,
      state: "stopping",
      retryable: true,
    });

    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(deps.teams.completeMemberLaunchCleanup).not.toHaveBeenCalled();
    expect(result.decisions[0]).toMatchObject({
      action: "cleanup_pending",
      executed: true,
    });
  });

  it("unwinds a foreign or absent child without sending a lifecycle stop", async () => {
    vi.mocked(deps.teams.reconcileStaleMemberLaunch).mockResolvedValueOnce({
      status: "cleanup",
      action: "unwind",
    });

    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(deps.lifecycle.stopSession).not.toHaveBeenCalled();
    expect(deps.teams.completeMemberLaunchCleanup).toHaveBeenCalledWith({
      memberId: "member-1",
      sessionId: "child-1",
      operationId: "launch-1",
    });
    expect(result.decisions[0]).toMatchObject({
      action: "cleanup_completed",
      executed: true,
    });
  });

  it("counts a failed cleanup once after its durable cleanup fence", async () => {
    vi.mocked(deps.teams.reconcileStaleMemberLaunch).mockResolvedValueOnce({
      status: "cleanup",
      action: "purge",
    });
    vi.mocked(deps.lifecycle.stopSession).mockRejectedValueOnce(
      new Error("lifecycle unavailable"),
    );

    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: false,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(result.actionsTaken).toBe(1);
    expect(result.decisions[0]).toMatchObject({
      action: "failed",
      executed: false,
      error: "lifecycle unavailable",
    });
  });

  it("never mutates launch state during a dry-run", async () => {
    const result = await reconcileTeamMemberLaunches(deps, {
      dryRun: true,
      limit: 20,
      maxActionsPerRun: 10,
      staleSeconds: 60,
    });

    expect(deps.teams.reconcileStaleMemberLaunch).not.toHaveBeenCalled();
    expect(result.decisions[0].action).toBe("dry_run");
  });
});
