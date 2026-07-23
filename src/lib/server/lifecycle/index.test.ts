import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDurableTarget } from "./resolvers";
import { DURABLE_RUNTIME_MISSING_STATUS } from "./cascade";

const mocks = vi.hoisted(() => ({
	resolveDurableTarget: vi.fn(),
	raiseSessionEvent: vi.fn(),
	cascadeDeps: {
    getParentStatus: vi.fn(),
    getParentCurrentNode: vi.fn(),
    getAgentRuntimeStatus: vi.fn(),
    cancelParent: vi.fn(),
    cancelAgentRuntime: vi.fn(),
    terminateParent: vi.fn(),
    terminateAgentRuntime: vi.fn(),
    waitParentClosed: vi.fn(),
    waitAgentRuntimeClosed: vi.fn(),
    purgeParent: vi.fn(),
    purgeAgentRuntime: vi.fn(),
		purgeStateRows: vi.fn(),
		deleteRuntimeSandbox: vi.fn(),
		deleteWorkspaceSandbox: vi.fn(),
    cleanupWorkspaceExecution: vi.fn(),
    sleep: vi.fn(async () => undefined),
    waitPollMs: 1,
  },
  workspaceRetention: {
    armTerminalRetention: vi.fn(),
  },
}));

vi.mock("$env/dynamic/private", () => ({
  env: {
    LIFECYCLE_TERMINATE_GRACE_SECONDS: "0",
    LIFECYCLE_CASCADE_WAIT_SECONDS: "5",
    LIFECYCLE_CASCADE_POLL_SECONDS: "1",
  },
}));

vi.mock("$lib/server/application/adapters/lifecycle-cascade", () => ({
  createDaprCascadeDeps: () => mocks.cascadeDeps,
}));

vi.mock("$lib/server/application/adapters/lifecycle-resolver", () => ({
  resolveDurableTarget: (...args: unknown[]) =>
    mocks.resolveDurableTarget(...args),
}));

vi.mock("$lib/server/application/adapters/workspace-retention-http", () => ({
  configuredWorkspaceRetentionPort: () => mocks.workspaceRetention,
}));

vi.mock("$lib/server/sessions/control", () => ({
  raiseSessionEvent: (...args: unknown[]) => mocks.raiseSessionEvent(...args),
}));

import { confirmDurableStop, stopDurableRun } from "./index";

function resolved(
  overrides: Partial<ResolvedDurableTarget> = {},
): ResolvedDurableTarget {
  const inferredRuntimeTargets = (overrides.sandboxNames ?? []).map((name) => ({
    runtimeAppId: name.replace(/^agent-host-/, ""),
    instanceId: "session-1",
    runtimeSandboxName: name,
  }));
  return {
    notFound: false,
    dbActive: true,
    dbStatus: "running",
    stopRequestedAt: null,
    stopRequestedMode: null,
    terminatedChildNodes: [],
    activeChildNodes: [],
    scope: { projectId: "project-1", userId: "user-1" },
    parentInstanceIds: [],
    agentRuntimeTargets: overrides.agentRuntimeTargets ?? inferredRuntimeTargets,
    runtimeProvisioningLeases: [],
    unresolvedRuntimeLinkages: [],
    sandboxNames: [],
    workspaceSandboxNames: [],
    workspaceRetentionIdentities: [],
    workspaceCleanupExecutionIds: [],
    statePurgeInstanceIds: [],
		acknowledgeRuntimeProvisioningCompensation: vi.fn(async () => true),
    finalizeDb: vi.fn(async () => "finalized" as const),
    markStopRequested: vi.fn(async (_reason, mode) => ({
      requestedAt: new Date(),
      mode,
    })),
    ...overrides,
  };
}

describe("durable lifecycle convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
		mocks.cascadeDeps.deleteRuntimeSandbox.mockResolvedValue(undefined);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("RUNNING");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue("RUNNING");
    mocks.cascadeDeps.cancelParent.mockResolvedValue("requested");
    mocks.cascadeDeps.cancelAgentRuntime.mockResolvedValue("requested");
    mocks.cascadeDeps.terminateParent.mockResolvedValue("terminated");
    mocks.cascadeDeps.terminateAgentRuntime.mockResolvedValue("terminated");
    mocks.cascadeDeps.waitParentClosed.mockResolvedValue(true);
    mocks.cascadeDeps.waitAgentRuntimeClosed.mockResolvedValue(true);
    mocks.cascadeDeps.purgeParent.mockResolvedValue(undefined);
    mocks.cascadeDeps.purgeAgentRuntime.mockResolvedValue(undefined);
    mocks.cascadeDeps.purgeStateRows.mockResolvedValue(undefined);
    mocks.cascadeDeps.deleteWorkspaceSandbox.mockResolvedValue(undefined);
    mocks.cascadeDeps.cleanupWorkspaceExecution.mockResolvedValue(undefined);
    mocks.workspaceRetention.armTerminalRetention.mockResolvedValue({
      terminalAt: "2026-07-21T18:30:00Z",
      resultCount: 1,
    });
  });

  it("fails closed before any cascade mutation when stop intent cannot persist", async () => {
    const target = resolved({
      markStopRequested: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );

    expect(result).toMatchObject({
      confirmed: false,
      requested: false,
      state: "stopping",
    });
    expect(target.markStopRequested).toHaveBeenCalledTimes(3);
    expect(mocks.cascadeDeps.cancelAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.terminateAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("keeps an active provisioning row stopping until its runtime linkage is published", async () => {
    const target = resolved({
      unresolvedRuntimeLinkages: ["session-1"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );

    expect(result).toMatchObject({
      confirmed: false,
      requested: true,
      state: "stopping",
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "resolve-runtime-linkage",
        result: "partial",
      }),
    );
    expect(mocks.cascadeDeps.terminateAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("lets a reconciler re-drive transient control failure without mutating on the intervening status read", async () => {
    const originalRequestedAt = new Date("2026-07-21T18:00:00.000Z");
    let persistedRequestedAt: Date | null = null;
    const target = resolved({
      stopRequestedAt: originalRequestedAt,
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-abc",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-abc",
        },
      ],
      sandboxNames: ["agent-host-agent-session-abc"],
      statePurgeInstanceIds: ["session-1"],
      markStopRequested: vi.fn(async (_reason, mode) => {
        persistedRequestedAt ??= originalRequestedAt;
        return { requestedAt: originalRequestedAt, mode };
      }),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.terminateAgentRuntime
      .mockResolvedValueOnce("failed")
      .mockResolvedValueOnce("terminated");

    const initial = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );
    expect(initial.state).toBe("stopping");
    expect(mocks.cascadeDeps.terminateAgentRuntime).toHaveBeenCalledTimes(1);

    const status = await confirmDurableStop({
      kind: "session",
      id: "session-1",
    });
    expect(status.state).toBe("stopping");
    expect(mocks.cascadeDeps.terminateAgentRuntime).toHaveBeenCalledTimes(1);

    const redriven = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );
    expect(redriven.state).toBe("confirmed");
    expect(mocks.cascadeDeps.terminateAgentRuntime).toHaveBeenCalledTimes(2);
    expect(target.markStopRequested).toHaveBeenCalledTimes(2);
    expect(persistedRequestedAt).toEqual(originalRequestedAt);
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).toHaveBeenCalledWith(
	      {
	        runtimeAppId: "agent-session-abc",
	        runtimeSandboxName: "agent-host-agent-session-abc",
	      },
    );
    expect(target.finalizeDb).toHaveBeenCalledTimes(1);
  });

  it("does not finalize when Sandbox reap fails and confirms on a later retry", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      sandboxNames: ["agent-host-agent-session-abc"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
		mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue("COMPLETED");
    mocks.cascadeDeps.deleteRuntimeSandbox
      .mockRejectedValueOnce(new Error("Kubernetes API unavailable"))
      .mockResolvedValueOnce("deleted");

    await expect(
      confirmDurableStop({ kind: "session", id: "session-1" }),
    ).resolves.toMatchObject({ state: "stopping" });
    expect(target.finalizeDb).not.toHaveBeenCalled();

    await expect(
      confirmDurableStop({ kind: "session", id: "session-1" }),
    ).resolves.toMatchObject({ state: "confirmed" });
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
    expect(target.finalizeDb).toHaveBeenCalledTimes(1);
  });

  it("keeps the command path nonterminal when purge cannot reap its Sandbox", async () => {
    const target = resolved({
      sandboxNames: ["agent-host-agent-session-abc"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.deleteRuntimeSandbox.mockRejectedValueOnce(
      new Error("delete rejected"),
    );

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );

    expect(result.state).toBe("stopping");
    expect(result.confirmed).toBe(false);
    expect(result.steps).toContainEqual({
      name: "finalize-db",
      result: "skipped",
      detail: "Sandbox reap has not succeeded",
    });
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("reaps dedicated compute on terminate without purging durable state", async () => {
    const target = resolved({
      sandboxNames: ["agent-host-agent-session-abc"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: true, state: "confirmed" });
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).toHaveBeenCalledWith(
	      {
	        runtimeAppId: "agent-session-abc",
	        runtimeSandboxName: "agent-host-agent-session-abc",
	      },
    );
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeAgentRuntime).not.toHaveBeenCalled();
    expect(target.finalizeDb).toHaveBeenCalledTimes(1);
  });

  it("arms retained OpenShell TTL before finalizing ordinary terminate", async () => {
    const finalizeDb = vi.fn(async () => "finalized" as const);
    const target = resolved({
      workspaceSandboxNames: ["workspace-session-1"],
      workspaceRetentionIdentities: [
        {
          durableExecutionId: "session-1",
          databaseExecutionId: null,
        },
      ],
      workspaceCleanupExecutionIds: ["workflow-execution-1"],
      finalizeDb,
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result.state).toBe("confirmed");
    expect(mocks.workspaceRetention.armTerminalRetention).toHaveBeenCalledWith({
      identity: {
        durableExecutionId: "session-1",
        databaseExecutionId: null,
      },
      terminalAt: expect.any(Date),
    });
    expect(mocks.cascadeDeps.deleteWorkspaceSandbox).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.cleanupWorkspaceExecution).not.toHaveBeenCalled();
    expect(finalizeDb).toHaveBeenCalledOnce();
    expect(
      mocks.workspaceRetention.armTerminalRetention.mock.invocationCallOrder[0],
    ).toBeLessThan(finalizeDb.mock.invocationCallOrder[0]);
  });

  it("leaves stop intent pending when retained-workspace arming fails", async () => {
    const target = resolved({
      workspaceRetentionIdentities: [
        {
          durableExecutionId: "durable-1",
          databaseExecutionId: "workflow-execution-1",
        },
      ],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.workspaceRetention.armTerminalRetention.mockRejectedValueOnce(
      new Error("provider unavailable"),
    );

    const result = await stopDurableRun(
      { kind: "workflowExecution", id: "workflow-execution-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({
      confirmed: false,
      requested: true,
      state: "stopping",
    });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "arm-workspace-retention:workflow-execution-1",
        result: "failed",
        detail: "provider unavailable",
      }),
    );
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("uses strict workspace deletion for purge without arming retention", async () => {
    const target = resolved({
      workspaceSandboxNames: ["workspace-session-1"],
      workspaceRetentionIdentities: [
        {
          durableExecutionId: "session-1",
          databaseExecutionId: null,
        },
      ],
      workspaceCleanupExecutionIds: ["workflow-execution-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "workflowExecution", id: "workflow-execution-1" },
      { mode: "purge", graceMs: 0 },
    );

    expect(result.state).toBe("confirmed");
    expect(mocks.cascadeDeps.deleteWorkspaceSandbox).toHaveBeenCalledWith(
      "workspace-session-1",
    );
    expect(mocks.cascadeDeps.cleanupWorkspaceExecution).toHaveBeenCalledWith(
      "workflow-execution-1",
    );
    expect(mocks.workspaceRetention.armTerminalRetention).not.toHaveBeenCalled();
  });

  it("keeps purge pending until execution-scoped OpenShell cleanup succeeds", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "purge",
      workspaceCleanupExecutionIds: ["workflow-execution-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.cleanupWorkspaceExecution
      .mockRejectedValueOnce(new Error("OpenShell unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-execution-1",
      }),
    ).resolves.toMatchObject({ state: "stopping" });
    expect(target.finalizeDb).not.toHaveBeenCalled();

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-execution-1",
      }),
    ).resolves.toMatchObject({ state: "confirmed" });
    expect(mocks.cascadeDeps.cleanupWorkspaceExecution).toHaveBeenCalledTimes(
      2,
    );
    expect(target.finalizeDb).toHaveBeenCalledOnce();
  });

  it("honors an already-escalated persisted mode during a weaker retry", async () => {
    const target = resolved({
      statePurgeInstanceIds: ["session-1"],
      markStopRequested: vi.fn(async () => ({
        requestedAt: new Date("2026-07-21T18:00:00.000Z"),
        mode: "reset" as const,
      })),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(target.markStopRequested).toHaveBeenCalledWith(
      "Stopped by user",
      "terminate",
    );
    expect(mocks.cascadeDeps.purgeStateRows).toHaveBeenCalled();
  });

  it("uses a stronger mode observed by the post-persistence refresh", async () => {
    const before = resolved({
      markStopRequested: vi.fn(async () => ({
        requestedAt: new Date("2026-07-21T18:00:00.000Z"),
        mode: "terminate" as const,
      })),
    });
    const after = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "reset",
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result.state).toBe("confirmed");
    expect(mocks.cascadeDeps.purgeStateRows).toHaveBeenCalled();
    expect(after.finalizeDb).toHaveBeenCalledWith(
      "Stopped by user",
      undefined,
      "reset",
    );
  });

  it("cascades to runtime linkage discovered after stop persistence", async () => {
    const before = resolved();
    const after = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "purge",
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-late",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-late",
        },
      ],
      sandboxNames: ["agent-host-agent-session-late"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "purge", graceMs: 0 },
    );
    expect(result.state).toBe("confirmed");
    expect(mocks.cascadeDeps.terminateAgentRuntime).toHaveBeenCalledWith(
      "agent-session-late",
      "session-1",
      "Stopped by user",
      "agent-host-agent-session-late",
    );
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).toHaveBeenCalledWith(
	      {
	        runtimeAppId: "agent-session-late",
	        runtimeSandboxName: "agent-host-agent-session-late",
	      },
    );
    expect(after.finalizeDb).toHaveBeenCalledOnce();
  });

  it("applies a persisted purge before delayed confirmation finalizes", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "purge",
      parentInstanceIds: ["workflow-1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-1",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-1",
        },
      ],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue("COMPLETED");

    const result = await confirmDurableStop({
      kind: "workflowExecution",
      id: "workflow-1",
    });

    expect(result.state).toBe("confirmed");
    expect(mocks.cascadeDeps.purgeAgentRuntime).toHaveBeenCalledWith(
      "agent-session-1",
      "session-1",
      "agent-host-agent-session-1",
    );
    expect(mocks.cascadeDeps.purgeParent).toHaveBeenCalledWith("workflow-1");
    expect(mocks.cascadeDeps.purgeStateRows).toHaveBeenCalledWith(
      ["workflow-1"],
      target.agentRuntimeTargets,
      ["session-1"],
    );
    expect(target.finalizeDb).toHaveBeenCalledWith(
      "stop confirmed",
      undefined,
      "purge",
    );
  });

  it.each(["purge", "reset"] as const)(
    "finalizes a terminal parent with a reaped child once for persisted %s",
    async (mode) => {
      const finalizeDb = vi.fn(async () => "finalized" as const);
      const target = resolved({
        stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
        stopRequestedMode: mode,
        parentInstanceIds: ["workflow-1"],
        agentRuntimeTargets: [
          {
            runtimeAppId: "agent-session-1",
            instanceId: "session-1",
            runtimeSandboxName: "agent-host-agent-session-1",
          },
        ],
        statePurgeInstanceIds: ["session-1"],
        finalizeDb,
      });
      mocks.resolveDurableTarget
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(
          resolved({
            notFound: true,
            dbActive: false,
            scope: null,
          }),
        );
      mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
      mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue(
        DURABLE_RUNTIME_MISSING_STATUS,
      );
      mocks.cascadeDeps.purgeParent.mockRejectedValue(
        new Error(
          "Failed to purge workflow workflow-1: rpc error: code = FailedPrecondition desc = did not find address for actor workflow-1",
        ),
      );

      await expect(
        confirmDurableStop({
          kind: "workflowExecution",
          id: "workflow-1",
        }),
      ).resolves.toMatchObject({ state: "confirmed" });
      await expect(
        confirmDurableStop({
          kind: "workflowExecution",
          id: "workflow-1",
        }),
      ).resolves.toMatchObject({ state: "notFound" });

      expect(mocks.cascadeDeps.purgeAgentRuntime).toHaveBeenCalledOnce();
      expect(mocks.cascadeDeps.purgeParent).toHaveBeenCalledOnce();
      expect(mocks.cascadeDeps.purgeStateRows).toHaveBeenCalledOnce();
      expect(finalizeDb).toHaveBeenCalledOnce();
      expect(
        mocks.cascadeDeps.purgeParent.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mocks.cascadeDeps.purgeStateRows.mock.invocationCallOrder[0],
      );
      expect(
        mocks.cascadeDeps.purgeStateRows.mock.invocationCallOrder[0],
      ).toBeLessThan(finalizeDb.mock.invocationCallOrder[0]);
    },
  );

  it("does not finalize a terminal parent while a cross-app child is live", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "reset",
      parentInstanceIds: ["workflow-1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-1",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-1",
        },
      ],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue("RUNNING");

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-1",
      }),
    ).resolves.toMatchObject({ state: "stopping" });

    expect(mocks.cascadeDeps.purgeAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeParent).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("does not finalize closed handles while runtime linkage is unresolved", async () => {
    const target = resolved({
      stopRequestedAt: new Date(),
      stopRequestedMode: "reset",
      parentInstanceIds: ["workflow-1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-1",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-1",
        },
      ],
      unresolvedRuntimeLinkages: ["session-unlinked"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue(
      DURABLE_RUNTIME_MISSING_STATUS,
    );

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-1",
      }),
    ).resolves.toMatchObject({ state: "stopping" });

    expect(mocks.cascadeDeps.purgeAgentRuntime).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeParent).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("does not normalize a parent actor miss for an aged unresolved linkage", async () => {
    const target = resolved({
      stopRequestedAt: new Date(Date.now() - 20 * 60_000),
      stopRequestedMode: "purge",
      parentInstanceIds: ["workflow-1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-1",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-1",
        },
      ],
      unresolvedRuntimeLinkages: ["session-unlinked"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue(
      DURABLE_RUNTIME_MISSING_STATUS,
    );
    mocks.cascadeDeps.purgeParent.mockRejectedValue(
      new Error(
        "Failed to purge workflow workflow-1: rpc error: code = FailedPrecondition desc = did not find address for actor workflow-1",
      ),
    );

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-1",
      }),
    ).resolves.toMatchObject({ state: "stopping" });

    expect(mocks.cascadeDeps.purgeParent).toHaveBeenCalledOnce();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("does not normalize a parent actor miss while a DB child remains active", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "reset",
      parentInstanceIds: ["workflow-1"],
      agentRuntimeTargets: [
        {
          runtimeAppId: "agent-session-1",
          instanceId: "session-1",
          runtimeSandboxName: "agent-host-agent-session-1",
        },
      ],
      activeChildNodes: ["agent-node"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("TERMINATED");
    mocks.cascadeDeps.getAgentRuntimeStatus.mockResolvedValue(
      DURABLE_RUNTIME_MISSING_STATUS,
    );
    mocks.cascadeDeps.purgeParent.mockRejectedValue(
      new Error(
        "Failed to purge workflow workflow-1: rpc error: code = FailedPrecondition desc = did not find address for actor workflow-1",
      ),
    );

    await expect(
      confirmDurableStop({
        kind: "workflowExecution",
        id: "workflow-1",
      }),
    ).resolves.toMatchObject({ state: "stopping" });

    expect(mocks.cascadeDeps.purgeParent).toHaveBeenCalledOnce();
    expect(mocks.cascadeDeps.purgeStateRows).not.toHaveBeenCalled();
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("does not acknowledge delayed purge when durable-state cleanup fails", async () => {
    const target = resolved({
      stopRequestedAt: new Date("2026-07-21T18:00:00.000Z"),
      stopRequestedMode: "purge",
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.purgeStateRows.mockRejectedValueOnce(
      new Error("postgres unavailable"),
    );

    const result = await confirmDurableStop({
      kind: "session",
      id: "session-1",
    });

    expect(result.state).toBe("stopping");
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("does not acknowledge a cross-app wedge when forced parent cleanup fails", async () => {
    const target = resolved({
      stopRequestedAt: new Date(Date.now() - 10 * 60_000),
      stopRequestedMode: "terminate",
      parentInstanceIds: ["workflow-1"],
      terminatedChildNodes: ["agent-node"],
      statePurgeInstanceIds: ["session-1"],
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);
    mocks.cascadeDeps.getParentStatus.mockResolvedValue("RUNNING");
    mocks.cascadeDeps.purgeStateRows.mockRejectedValueOnce(
      new Error("state store unavailable"),
    );

    const result = await confirmDurableStop({
      kind: "workflowExecution",
      id: "workflow-1",
    });

    expect(result.state).toBe("stopping");
    expect(mocks.cascadeDeps.purgeStateRows).toHaveBeenCalledOnce();
    expect(target.finalizeDb).not.toHaveBeenCalled();
    expect(mocks.cascadeDeps.deleteRuntimeSandbox).not.toHaveBeenCalled();
  });

  it("keeps a concurrently escalated stop pending when finalization loses its mode fence", async () => {
    const target = resolved({
      finalizeDb: vi.fn(async () => "mode_changed" as const),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: false, state: "stopping" });
    expect(result.steps).toContainEqual({
      name: "finalize-db",
      result: "partial",
      detail: "a stronger concurrent stop intent remains pending",
    });
  });

  it("finalizes a targetless provisioning row after the bounded grace", async () => {
    const requestedAt = new Date(Date.now() - 10 * 60_000);
    const target = resolved({
      stopRequestedAt: requestedAt,
      unresolvedRuntimeLinkages: ["session-1"],
      markStopRequested: vi.fn(async (_reason, mode) => ({
        requestedAt,
        mode,
      })),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: true, state: "confirmed" });
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "resolve-runtime-linkage",
        result: "skipped",
      }),
    );
    expect(target.finalizeDb).toHaveBeenCalledOnce();
  });

  it("keeps a fresh provisioning lease blocked even when the stop intent is old", async () => {
    const requestedAt = new Date(Date.now() - 20 * 60_000);
    const prospectiveTarget = {
      runtimeAppId: "agent-session-prospective",
      instanceId: "session-1",
      runtimeSandboxName: "agent-host-agent-session-prospective",
    };
    const target = resolved({
      stopRequestedAt: requestedAt,
      agentRuntimeTargets: [prospectiveTarget],
			sandboxNames: [prospectiveTarget.runtimeSandboxName],
      runtimeProvisioningLeases: [
        {
          sessionId: "session-1",
          startedAt: new Date(),
          prospectiveTarget,
        },
      ],
      unresolvedRuntimeLinkages: ["session-1"],
      markStopRequested: vi.fn(async (_reason, mode) => ({
        requestedAt,
        mode,
      })),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: false, state: "stopping" });
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });

  it("controls an expired prospective target and converges from the lease clock", async () => {
    const requestedAt = new Date();
    const prospectiveTarget = {
      runtimeAppId: "agent-session-prospective",
      instanceId: "session-1",
      runtimeSandboxName: "agent-host-agent-session-prospective",
    };
    const target = resolved({
      agentRuntimeTargets: [prospectiveTarget],
			sandboxNames: [prospectiveTarget.runtimeSandboxName],
      runtimeProvisioningLeases: [
        {
          sessionId: "session-1",
          startedAt: new Date(Date.now() - 10 * 60_000 - 1_000),
          prospectiveTarget,
        },
      ],
      unresolvedRuntimeLinkages: ["session-1"],
      markStopRequested: vi.fn(async (_reason, mode) => ({
        requestedAt,
        mode,
      })),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "session", id: "session-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: true, state: "confirmed" });
    expect(mocks.cascadeDeps.terminateAgentRuntime).toHaveBeenCalledWith(
      prospectiveTarget.runtimeAppId,
      prospectiveTarget.instanceId,
      "Stopped by user",
      prospectiveTarget.runtimeSandboxName,
    );
		expect(mocks.cascadeDeps.deleteRuntimeSandbox).toHaveBeenCalledWith(
			{
				runtimeAppId: prospectiveTarget.runtimeAppId,
				runtimeSandboxName: prospectiveTarget.runtimeSandboxName,
			},
		);
		expect(
			target.acknowledgeRuntimeProvisioningCompensation,
		).toHaveBeenCalledWith(
			"session-1",
			target.runtimeProvisioningLeases[0].startedAt,
		);
		expect(
			vi.mocked(mocks.cascadeDeps.deleteRuntimeSandbox).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(target.acknowledgeRuntimeProvisioningCompensation).mock
				.invocationCallOrder[0],
		);
    expect(target.finalizeDb).toHaveBeenCalledOnce();
  });

	it("keeps stop pending when exact provisioning acknowledgement loses its CAS", async () => {
		const requestedAt = new Date();
		const prospectiveTarget = {
			runtimeAppId: "agent-session-prospective",
			instanceId: "session-1",
			runtimeSandboxName: "agent-host-agent-session-prospective",
		};
		const target = resolved({
			agentRuntimeTargets: [prospectiveTarget],
			sandboxNames: [prospectiveTarget.runtimeSandboxName],
			runtimeProvisioningLeases: [
				{
					sessionId: "session-1",
					startedAt: new Date(Date.now() - 10 * 60_000 - 1_000),
					prospectiveTarget,
				},
			],
			unresolvedRuntimeLinkages: ["session-1"],
			acknowledgeRuntimeProvisioningCompensation: vi.fn(async () => false),
			markStopRequested: vi.fn(async (_reason, mode) => ({
				requestedAt,
				mode,
			})),
		});
		mocks.resolveDurableTarget.mockResolvedValue(target);

		const result = await stopDurableRun(
			{ kind: "session", id: "session-1" },
			{ mode: "terminate", graceMs: 0 },
		);

		expect(result).toMatchObject({ confirmed: false, state: "stopping" });
		expect(result.steps).toContainEqual({
			name: "ack-runtime-provisioning:session-1",
			result: "failed",
			detail: "lease generation changed; re-resolving before finalization",
		});
		expect(target.finalizeDb).not.toHaveBeenCalled();
	});

	it("does not acknowledge a provisioning lease when its Sandbox reap fails", async () => {
		const requestedAt = new Date();
		const prospectiveTarget = {
			runtimeAppId: "agent-session-prospective",
			instanceId: "session-1",
			runtimeSandboxName: "agent-host-agent-session-prospective",
		};
		const target = resolved({
			agentRuntimeTargets: [prospectiveTarget],
			sandboxNames: [prospectiveTarget.runtimeSandboxName],
			runtimeProvisioningLeases: [
				{
					sessionId: "session-1",
					startedAt: new Date(Date.now() - 10 * 60_000 - 1_000),
					prospectiveTarget,
				},
			],
			unresolvedRuntimeLinkages: ["session-1"],
			markStopRequested: vi.fn(async (_reason, mode) => ({
				requestedAt,
				mode,
			})),
		});
		mocks.resolveDurableTarget.mockResolvedValue(target);
		mocks.cascadeDeps.deleteRuntimeSandbox.mockRejectedValueOnce(
			new Error("delete failed"),
		);

		const result = await stopDurableRun(
			{ kind: "session", id: "session-1" },
			{ mode: "terminate", graceMs: 0 },
		);

		expect(result).toMatchObject({ confirmed: false, state: "stopping" });
		expect(
			target.acknowledgeRuntimeProvisioningCompensation,
		).not.toHaveBeenCalled();
		expect(target.finalizeDb).not.toHaveBeenCalled();
	});

  it("keeps an aggregate blocked while any child lease is fresh", async () => {
    const requestedAt = new Date(Date.now() - 20 * 60_000);
    const prospectiveTarget = {
      runtimeAppId: "agent-session-prospective",
      instanceId: "session-fresh",
      runtimeSandboxName: "agent-host-agent-session-prospective",
    };
    const target = resolved({
      runtimeProvisioningLeases: [
        {
          sessionId: "session-expired",
          startedAt: new Date(Date.now() - 20 * 60_000),
          prospectiveTarget: {
            ...prospectiveTarget,
            instanceId: "session-expired",
          },
        },
        {
          sessionId: "session-fresh",
          startedAt: new Date(),
          prospectiveTarget,
        },
      ],
      unresolvedRuntimeLinkages: ["session-expired", "session-fresh"],
      markStopRequested: vi.fn(async (_reason, mode) => ({
        requestedAt,
        mode,
      })),
    });
    mocks.resolveDurableTarget.mockResolvedValue(target);

    const result = await stopDurableRun(
      { kind: "workflowExecution", id: "workflow-1" },
      { mode: "terminate", graceMs: 0 },
    );

    expect(result).toMatchObject({ confirmed: false, state: "stopping" });
    expect(target.finalizeDb).not.toHaveBeenCalled();
  });
});
