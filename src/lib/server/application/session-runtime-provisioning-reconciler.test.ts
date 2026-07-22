import { describe, expect, it, vi } from "vitest";
import type {
  SessionRuntimeProvisioningReconciliationStore,
  StaleSessionRuntimeProvisioningTarget,
} from "./ports";
import {
  reconcileStaleSessionRuntimeProvisioning,
  type SessionRuntimeProvisioningReconcilerDeps,
} from "./session-runtime-provisioning-reconciler";

const STARTED_AT = new Date("2026-07-21T18:00:00.000Z");
const TAKEOVER_AT = new Date("2026-07-21T20:10:00.002Z");
const TARGET: StaleSessionRuntimeProvisioningTarget = {
  sessionId: "session-1",
  startedAt: STARTED_AT,
  runtimeAppId: "agent-runtime-shared-pool",
  durableInstanceId: "session-runtime-gen1",
  runtimeSandboxName: null,
  runtimeHostOwned: false,
  runtimeHostLaunchSpec: null,
  publishedGeneration: false,
};

function depsFor(
  state: "active" | "terminal" | "not_found" | "unknown",
  target: StaleSessionRuntimeProvisioningTarget = TARGET,
): SessionRuntimeProvisioningReconcilerDeps {
  const store: SessionRuntimeProvisioningReconciliationStore = {
    listStaleSessionRuntimeProvisioningTargets: vi.fn(async () => [target]),
    attachStagedSessionRuntimeProvisioning: vi.fn(async () => true),
    completeStagedSessionRuntimeProvisioning: vi.fn(
      async () => "completed" as const,
    ),
    claimStaleSessionRuntimeProvisioning: vi.fn(async () => true),
    prepareClaimedSessionRuntimeProvisioningRedrive: vi.fn(async () => true),
  };
  return {
    store,
    runtimeInspector: {
      inspectRuntimeInstance: vi.fn(async () => state),
    },
    runtimeCleaner: {
      purgeRuntimeInstance: vi.fn(async () => undefined),
    },
    sandboxDestroyer: {
      deleteRuntimeSandbox: vi.fn(async (name) => ({
        name,
        kind: "runtime" as const,
        status: "deleted" as const,
      })),
    },
    runtimeHostEnsurer: {
      ensurePublished: vi.fn(async () => undefined),
    },
    generationFactory: {
      createReplacement: vi.fn(({ current, startedAt }) => {
        const suffix = startedAt.getTime().toString(16);
        const runtimeAppId = current.runtimeHostOwned
          ? `replacement-app-${suffix}`
          : current.runtimeAppId;
        return {
          runtimeAppId,
          durableInstanceId: `replacement-instance-${suffix}`,
          runtimeSandboxName: current.runtimeHostOwned
            ? `replacement-sandbox-${suffix}`
            : current.runtimeSandboxName,
          runtimeHostOwned: current.runtimeHostOwned,
          runtimeHostLaunchSpec: current.runtimeHostOwned
            ? { replacementFor: runtimeAppId }
            : current.runtimeHostLaunchSpec,
        };
      }),
    },
    redriveSession: vi.fn(async (staged) => ({
      instanceId: staged.durableInstanceId,
    })),
    now: vi.fn(() => new Date("2026-07-21T20:00:00.000Z").getTime()),
  };
}

function ownedTarget(
  overrides: Partial<StaleSessionRuntimeProvisioningTarget> = {},
): StaleSessionRuntimeProvisioningTarget {
  const runtimeAppId = overrides.runtimeAppId ?? "agent-session-generation-1";
  return {
    ...TARGET,
    runtimeAppId,
    runtimeSandboxName:
      overrides.runtimeSandboxName ?? `agent-host-${runtimeAppId}`,
    runtimeHostOwned: true,
    runtimeHostLaunchSpec: {
      version: 1,
      request: { agentAppId: runtimeAppId },
      secretEnvKeys: [],
    },
    ...overrides,
  };
}

const OPTIONS = {
  dryRun: false,
  limit: 20,
  maxActionsPerRun: 10,
  staleSeconds: 600,
};

describe("stale session runtime provisioning reconciler", () => {
  it("CAS-publishes an accepted active exact generation", async () => {
    const deps = depsFor("active");
    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(result.decisions).toEqual([
      expect.objectContaining({
        instanceId: "session-runtime-gen1",
        state: "active",
        outcome: "attached_active",
        executed: true,
      }),
    ]);
    expect(
      deps.store.attachStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
    });
    expect(deps.runtimeCleaner.purgeRuntimeInstance).not.toHaveBeenCalled();
    expect(deps.runtimeHostEnsurer.ensurePublished).not.toHaveBeenCalled();
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt: STARTED_AT,
      runtimeAppId: "agent-runtime-shared-pool",
    });
    expect(deps.redriveSession).not.toHaveBeenCalled();
  });

  it("activates an owned exact host only after its target is published", async () => {
    const deps = depsFor(
      "active",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-agent-session-generation-1",
      }),
    );
    const order: string[] = [];
    vi.mocked(
      deps.store.attachStagedSessionRuntimeProvisioning,
    ).mockImplementation(async () => {
      order.push("attach");
      return true;
    });
    vi.mocked(deps.runtimeHostEnsurer.ensurePublished).mockImplementation(
      async () => {
        order.push("activate");
      },
    );
    vi.mocked(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).mockImplementation(async () => {
      order.push("complete");
      return "completed";
    });

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(order).toEqual(["attach", "activate", "complete"]);
    expect(deps.runtimeHostEnsurer.ensurePublished).toHaveBeenCalledWith({
      sessionId: "session-1",
      runtimeAppId: "agent-session-generation-1",
      runtimeSandboxName: "agent-host-agent-session-generation-1",
    });
    expect(result.decisions[0]).toMatchObject({
      outcome: "attached_active",
      executed: true,
    });
  });

  it("does not activate an owned host when publication loses its lease", async () => {
    const deps = depsFor(
      "active",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-agent-session-generation-1",
      }),
    );
    vi.mocked(
      deps.store.attachStagedSessionRuntimeProvisioning,
    ).mockResolvedValue(false);

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(deps.runtimeHostEnsurer.ensurePublished).not.toHaveBeenCalled();
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).not.toHaveBeenCalled();
    expect(result.decisions[0]).toMatchObject({
      outcome: "superseded",
      executed: true,
    });
  });

  it("retains and retries the exact lease after host activation fails", async () => {
    const deps = depsFor(
      "active",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-agent-session-generation-1",
      }),
    );
    vi.mocked(deps.runtimeHostEnsurer.ensurePublished)
      .mockRejectedValueOnce(new Error("provider activation unavailable"))
      .mockResolvedValueOnce(undefined);

    const first = await reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS);
    const second = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(first.decisions[0]).toMatchObject({
      outcome: "error",
      executed: true,
      error: "provider activation unavailable",
    });
    expect(second.decisions[0]).toMatchObject({
      outcome: "attached_active",
      executed: true,
    });
    expect(
      deps.store.attachStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledTimes(2);
    expect(deps.runtimeHostEnsurer.ensurePublished).toHaveBeenCalledTimes(2);
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledTimes(1);
    expect(deps.redriveSession).not.toHaveBeenCalled();
  });

  it("retries idempotent activation after a crash before completion", async () => {
    const deps = depsFor(
      "active",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-agent-session-generation-1",
      }),
    );
    vi.mocked(deps.store.completeStagedSessionRuntimeProvisioning)
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce("completed");

    const first = await reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS);
    const second = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(first.decisions[0]).toMatchObject({
      outcome: "error",
      error: "database temporarily unavailable",
    });
    expect(second.decisions[0]).toMatchObject({ outcome: "attached_active" });
    expect(deps.runtimeHostEnsurer.ensurePublished).toHaveBeenCalledTimes(2);
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledTimes(2);
  });

  it("leaves the exact lease to lifecycle cleanup when stop wins completion", async () => {
    const deps = depsFor(
      "active",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-agent-session-generation-1",
      }),
    );
    vi.mocked(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).mockResolvedValue("stopped");

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(result.decisions[0]).toMatchObject({
      outcome: "superseded",
      executed: true,
    });
    expect(deps.runtimeHostEnsurer.ensurePublished).toHaveBeenCalledTimes(1);
    expect(deps.redriveSession).not.toHaveBeenCalled();
  });

  it("recovers an absent already-published owned host and completes its lease", async () => {
    const target = ownedTarget({ publishedGeneration: true });
    const deps = depsFor("not_found", target);

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(deps.runtimeHostEnsurer.ensurePublished).toHaveBeenCalledWith({
      sessionId: target.sessionId,
      runtimeAppId: target.runtimeAppId,
      runtimeSandboxName: target.runtimeSandboxName,
    });
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: target.sessionId,
      expectedStartedAt: target.startedAt,
      runtimeAppId: target.runtimeAppId,
    });
    expect(
      deps.store.claimStaleSessionRuntimeProvisioning,
    ).not.toHaveBeenCalled();
    expect(deps.runtimeCleaner.purgeRuntimeInstance).not.toHaveBeenCalled();
    expect(deps.sandboxDestroyer.deleteRuntimeSandbox).not.toHaveBeenCalled();
    expect(deps.redriveSession).not.toHaveBeenCalled();
    expect(result.decisions[0]).toMatchObject({
      outcome: "recovered_published_generation",
    });
  });

  it("clears a published shared-runtime recovery lease without host cleanup", async () => {
    const target = { ...TARGET, publishedGeneration: true };
    const deps = depsFor("terminal", target);

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    expect(deps.runtimeHostEnsurer.ensurePublished).not.toHaveBeenCalled();
    expect(
      deps.store.completeStagedSessionRuntimeProvisioning,
    ).toHaveBeenCalledWith({
      sessionId: target.sessionId,
      expectedStartedAt: target.startedAt,
      runtimeAppId: target.runtimeAppId,
    });
    expect(deps.runtimeCleaner.purgeRuntimeInstance).not.toHaveBeenCalled();
    expect(deps.redriveSession).not.toHaveBeenCalled();
    expect(result.decisions[0]).toMatchObject({
      outcome: "recovered_published_generation",
    });
  });

  it("repairs crash-after-stage-before-start without another caller", async () => {
    const deps = depsFor("not_found");
    let published: { instanceId: string; status: string } | null = null;
    vi.mocked(deps.redriveSession).mockImplementation(async (staged) => {
      published = { instanceId: staged.durableInstanceId, status: "running" };
      return { instanceId: staged.durableInstanceId };
    });

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );

    const claim = vi.mocked(deps.store.claimStaleSessionRuntimeProvisioning)
      .mock.calls[0][0];
    const prepared = vi.mocked(
      deps.store.prepareClaimedSessionRuntimeProvisioningRedrive,
    ).mock.calls[0][0];
    expect(claim.current).toEqual(TARGET);
    expect(prepared.claimed).toEqual({
      ...TARGET,
      startedAt: claim.claimedAt,
    });
    expect(prepared.replacement.startedAt).toEqual(claim.claimedAt);
    expect(prepared.replacement.durableInstanceId).not.toBe(
      TARGET.durableInstanceId,
    );
    expect(result.decisions).toEqual([
      expect.objectContaining({
        state: "not_found",
        outcome: "redriven_missing",
        replacementInstanceId: prepared.replacement.durableInstanceId,
      }),
    ]);
    expect(published).toEqual({
      instanceId: prepared.replacement.durableInstanceId,
      status: "running",
    });
    expect(deps.runtimeCleaner.purgeRuntimeInstance).not.toHaveBeenCalled();
    expect(deps.redriveSession).toHaveBeenCalledWith(prepared.replacement);
  });

  it("reaps an owned missing host before redrive but never deletes a shared pool", async () => {
    const owned = ownedTarget({
      runtimeAppId: "agent-session-generation-1",
      runtimeSandboxName: "agent-host-generation-1",
    });
    const ownedDeps = depsFor("not_found", owned);
    const order: string[] = [];
    vi.mocked(
      ownedDeps.sandboxDestroyer.deleteRuntimeSandbox,
    ).mockImplementation(async (name) => {
      order.push(`delete:${name}`);
      return { name, kind: "runtime", status: "deleted" };
    });
    vi.mocked(ownedDeps.redriveSession).mockImplementation(async (staged) => {
      order.push("redrive");
      return { instanceId: staged.durableInstanceId };
    });

    await reconcileStaleSessionRuntimeProvisioning(ownedDeps, OPTIONS);
    expect(order).toEqual(["delete:agent-host-generation-1", "redrive"]);

    const sharedDeps = depsFor("not_found");
    await reconcileStaleSessionRuntimeProvisioning(sharedDeps, OPTIONS);
    expect(
      sharedDeps.sandboxDestroyer.deleteRuntimeSandbox,
    ).not.toHaveBeenCalled();
  });

  it("purges a terminal exact instance before host cleanup and rotation", async () => {
    const deps = depsFor(
      "terminal",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-generation-1",
      }),
    );
    const order: string[] = [];
    vi.mocked(deps.runtimeCleaner.purgeRuntimeInstance).mockImplementation(
      async () => {
        order.push("purge");
      },
    );
    vi.mocked(deps.sandboxDestroyer.deleteRuntimeSandbox).mockImplementation(
      async (name) => {
        order.push("delete");
        return { name, kind: "runtime", status: "deleted" };
      },
    );
    vi.mocked(deps.redriveSession).mockImplementation(async (staged) => {
      order.push("redrive");
      return { instanceId: staged.durableInstanceId };
    });

    const result = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );
    expect(order).toEqual(["purge", "delete", "redrive"]);
    expect(result.decisions[0]).toMatchObject({
      outcome: "redriven_terminal",
    });
  });

  it("leaves unknown or superseded leases untouched", async () => {
    const unknown = depsFor("unknown");
    await reconcileStaleSessionRuntimeProvisioning(unknown, OPTIONS);
    expect(
      unknown.store.claimStaleSessionRuntimeProvisioning,
    ).not.toHaveBeenCalled();
    expect(unknown.redriveSession).not.toHaveBeenCalled();

    const superseded = depsFor("not_found");
    vi.mocked(
      superseded.store.claimStaleSessionRuntimeProvisioning,
    ).mockResolvedValue(false);
    const result = await reconcileStaleSessionRuntimeProvisioning(
      superseded,
      OPTIONS,
    );
    expect(result.decisions[0]).toMatchObject({ outcome: "superseded" });
    expect(
      superseded.sandboxDestroyer.deleteRuntimeSandbox,
    ).not.toHaveBeenCalled();
    expect(superseded.redriveSession).not.toHaveBeenCalled();
  });

  it("rotates a failed staged replacement after its cleanup claim becomes stale", async () => {
    const deps = depsFor("not_found");
    let nowMs = new Date("2026-07-21T20:00:00.000Z").getTime();
    vi.mocked(deps.now).mockImplementation(() => nowMs);
    vi.mocked(deps.redriveSession)
      .mockRejectedValueOnce(
        new Error("runtime host was temporarily unavailable"),
      )
      .mockImplementationOnce(async (staged) => ({
        instanceId: staged.durableInstanceId,
      }));

    const first = await reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS);
    const firstReplacement = vi.mocked(
      deps.store.prepareClaimedSessionRuntimeProvisioningRedrive,
    ).mock.calls[0][0].replacement;
    expect(first.decisions[0]).toMatchObject({
      outcome: "error",
      instanceId: "session-runtime-gen1",
    });

    nowMs = TAKEOVER_AT.getTime();
    vi.mocked(
      deps.store.listStaleSessionRuntimeProvisioningTargets,
    ).mockResolvedValueOnce([firstReplacement]);
    const second = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );
    const secondReplacement = vi.mocked(
      deps.store.prepareClaimedSessionRuntimeProvisioningRedrive,
    ).mock.calls[1][0].replacement;
    expect(second.decisions[0]).toMatchObject({
      outcome: "redriven_missing",
      instanceId: firstReplacement.durableInstanceId,
      replacementInstanceId: secondReplacement.durableInstanceId,
    });
    expect(secondReplacement.durableInstanceId).not.toBe(
      firstReplacement.durableInstanceId,
    );
    expect(deps.redriveSession).toHaveBeenNthCalledWith(1, firstReplacement);
    expect(deps.redriveSession).toHaveBeenNthCalledWith(2, secondReplacement);
  });

  it("allows only one worker to delete and redrive an exact stale generation", async () => {
    const deps = depsFor(
      "terminal",
      ownedTarget({
        runtimeAppId: "agent-session-generation-1",
        runtimeSandboxName: "agent-host-generation-1",
      }),
    );
    let claimed = false;
    vi.mocked(
      deps.store.claimStaleSessionRuntimeProvisioning,
    ).mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });

    const results = await Promise.all([
      reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS),
      reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS),
    ]);

    expect(deps.runtimeCleaner.purgeRuntimeInstance).toHaveBeenCalledTimes(1);
    expect(deps.sandboxDestroyer.deleteRuntimeSandbox).toHaveBeenCalledTimes(1);
    expect(deps.redriveSession).toHaveBeenCalledTimes(1);
    expect(results.map((result) => result.decisions[0].outcome).sort()).toEqual(
      ["redriven_terminal", "superseded"],
    );
  });

  it("a late cleanup worker cannot delete or redrive a replacement generation", async () => {
    const initial = ownedTarget({
      runtimeAppId: "agent-session-generation-1",
      runtimeSandboxName: "agent-host-generation-1",
    });
    const deps = depsFor("terminal", initial);
    let persisted = initial;
    let nowMs = new Date("2026-07-21T20:00:00.000Z").getTime();
    vi.mocked(deps.now).mockImplementation(() => nowMs);
    vi.mocked(
      deps.store.listStaleSessionRuntimeProvisioningTargets,
    ).mockImplementation(async () => [persisted]);
    vi.mocked(
      deps.store.claimStaleSessionRuntimeProvisioning,
    ).mockImplementation(async ({ current, claimedAt }) => {
      if (
        persisted.startedAt.getTime() !== current.startedAt.getTime() ||
        persisted.runtimeAppId !== current.runtimeAppId ||
        persisted.durableInstanceId !== current.durableInstanceId
      ) {
        return false;
      }
      persisted = { ...persisted, startedAt: claimedAt };
      return true;
    });
    vi.mocked(
      deps.store.prepareClaimedSessionRuntimeProvisioningRedrive,
    ).mockImplementation(async ({ claimed, replacement }) => {
      if (
        persisted.startedAt.getTime() !== claimed.startedAt.getTime() ||
        persisted.runtimeAppId !== claimed.runtimeAppId ||
        persisted.durableInstanceId !== claimed.durableInstanceId
      ) {
        return false;
      }
      persisted = replacement;
      return true;
    });

    let releaseFirstPurge!: () => void;
    let signalFirstPurge!: () => void;
    const firstPurgeStarted = new Promise<void>((resolve) => {
      signalFirstPurge = resolve;
    });
    const firstPurgeReleased = new Promise<void>((resolve) => {
      releaseFirstPurge = resolve;
    });
    let purgeCount = 0;
    vi.mocked(deps.runtimeCleaner.purgeRuntimeInstance).mockImplementation(
      async () => {
        purgeCount += 1;
        if (purgeCount === 1) {
          signalFirstPurge();
          await firstPurgeReleased;
        }
      },
    );

    const workerA = reconcileStaleSessionRuntimeProvisioning(deps, OPTIONS);
    await firstPurgeStarted;
    nowMs = TAKEOVER_AT.getTime();
    const workerB = await reconcileStaleSessionRuntimeProvisioning(
      deps,
      OPTIONS,
    );
    const publishedReplacement = vi.mocked(deps.redriveSession).mock
      .calls[0][0];
    releaseFirstPurge();
    const lateWorker = await workerA;

    expect(workerB.decisions[0]).toMatchObject({
      outcome: "redriven_terminal",
      replacementInstanceId: publishedReplacement.durableInstanceId,
    });
    expect(lateWorker.decisions[0]).toMatchObject({ outcome: "superseded" });
    expect(deps.redriveSession).toHaveBeenCalledTimes(1);
    expect(publishedReplacement.durableInstanceId).not.toBe(
      initial.durableInstanceId,
    );
    expect(deps.runtimeCleaner.purgeRuntimeInstance).toHaveBeenCalledTimes(2);
    expect(deps.sandboxDestroyer.deleteRuntimeSandbox).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(deps.sandboxDestroyer.deleteRuntimeSandbox)
        .mock.calls.map(([name]) => name),
    ).toEqual([initial.runtimeSandboxName, initial.runtimeSandboxName]);
    expect(
      vi
        .mocked(deps.sandboxDestroyer.deleteRuntimeSandbox)
        .mock.calls.some(
          ([name]) => name === publishedReplacement.runtimeSandboxName,
        ),
    ).toBe(false);
  });

  it("honors dry-run and action caps", async () => {
    const dry = depsFor("active");
    const dryResult = await reconcileStaleSessionRuntimeProvisioning(dry, {
      ...OPTIONS,
      dryRun: true,
    });
    expect(dryResult.actionsTaken).toBe(0);
    expect(
      dry.store.attachStagedSessionRuntimeProvisioning,
    ).not.toHaveBeenCalled();

    const capped = depsFor("active");
    const cappedResult = await reconcileStaleSessionRuntimeProvisioning(
      capped,
      {
        ...OPTIONS,
        maxActionsPerRun: 0,
      },
    );
    expect(cappedResult.decisions[0]).toMatchObject({
      outcome: "action_cap_reached",
      executed: false,
    });
  });
});
