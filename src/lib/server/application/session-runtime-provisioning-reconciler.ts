import type {
  SessionRuntimeCleanupPort,
  SessionRuntimeProvisioningGenerationFactory,
  SessionRuntimeInspectionPort,
  SessionRuntimeProvisioningReconciliationStore,
  SessionSandboxDestroyer,
  StaleSessionRuntimeProvisioningTarget,
} from "$lib/server/application/ports";

export type SessionRuntimeProvisioningReconcileOutcome =
  | "attached_active"
  | "redriven_missing"
  | "redriven_terminal"
  | "recovered_published_generation"
  | "unknown"
  | "superseded"
  | "action_cap_reached"
  | "error";

export type SessionRuntimeProvisioningReconcileDecision = {
  sessionId: string;
  instanceId: string;
  state: "active" | "terminal" | "not_found" | "unknown";
  outcome: SessionRuntimeProvisioningReconcileOutcome;
  executed: boolean;
  replacementInstanceId?: string;
  error?: string;
};

export type SessionRuntimeProvisioningReconcileResult = {
  scanned: number;
  actionsTaken: number;
  dryRun: boolean;
  decisions: SessionRuntimeProvisioningReconcileDecision[];
};

export type SessionRuntimeProvisioningHostEnsurer = {
  ensurePublished(input: {
    sessionId: string;
    runtimeAppId: string;
    runtimeSandboxName: string;
  }): Promise<void>;
};

export type SessionRuntimeProvisioningReconcilerDeps = {
  store: SessionRuntimeProvisioningReconciliationStore;
  runtimeInspector: SessionRuntimeInspectionPort;
  runtimeCleaner: SessionRuntimeCleanupPort;
  sandboxDestroyer: Pick<SessionSandboxDestroyer, "deleteRuntimeSandbox">;
  runtimeHostEnsurer: SessionRuntimeProvisioningHostEnsurer;
  generationFactory: SessionRuntimeProvisioningGenerationFactory;
  redriveSession(
    target: StaleSessionRuntimeProvisioningTarget,
  ): Promise<{ instanceId: string }>;
  now(): number;
};

export type SessionRuntimeProvisioningReconcileOptions = {
  dryRun: boolean;
  limit: number;
  maxActionsPerRun: number;
  staleSeconds: number;
};

function exactLease(target: StaleSessionRuntimeProvisioningTarget) {
  return {
    sessionId: target.sessionId,
    expectedStartedAt: target.startedAt,
  };
}

async function deleteOwnedRuntimeHost(
  deps: SessionRuntimeProvisioningReconcilerDeps,
  target: StaleSessionRuntimeProvisioningTarget,
): Promise<void> {
  if (!target.runtimeHostOwned) return;
  const sandboxName = target.runtimeSandboxName?.trim();
  if (!sandboxName) {
    throw new Error("owned staged runtime is missing its Sandbox name");
  }
  const deleted = await deps.sandboxDestroyer.deleteRuntimeSandbox(sandboxName);
  if (deleted.status === "error") {
    throw new Error(
      deleted.error || `failed to delete runtime Sandbox ${sandboxName}`,
    );
  }
}

async function ensureOwnedPublishedRuntimeHost(
  deps: SessionRuntimeProvisioningReconcilerDeps,
  target: StaleSessionRuntimeProvisioningTarget,
): Promise<void> {
  if (!target.runtimeHostOwned) return;
  const runtimeSandboxName = target.runtimeSandboxName?.trim();
  if (!runtimeSandboxName) {
    throw new Error("owned staged runtime is missing its Sandbox name");
  }
  await deps.runtimeHostEnsurer.ensurePublished({
    sessionId: target.sessionId,
    runtimeAppId: target.runtimeAppId,
    runtimeSandboxName,
  });
}

/**
 * Repair the crash window after an exact target was staged but before its
 * accepted durable start was published. Every destructive action remains
 * fenced by the immutable lease token. Unknown evidence never rotates a lease.
 */
export async function reconcileStaleSessionRuntimeProvisioning(
  deps: SessionRuntimeProvisioningReconcilerDeps,
  options: SessionRuntimeProvisioningReconcileOptions,
): Promise<SessionRuntimeProvisioningReconcileResult> {
  const limit = Math.max(1, Math.min(Math.trunc(options.limit || 20), 200));
  const targets = await deps.store.listStaleSessionRuntimeProvisioningTargets({
    staleBefore: new Date(deps.now() - options.staleSeconds * 1_000),
    limit,
  });
  const decisions: SessionRuntimeProvisioningReconcileDecision[] = [];
  let actionsTaken = 0;

  for (const target of targets) {
    const state = await deps.runtimeInspector
      .inspectRuntimeInstance({
        runtimeAppId: target.runtimeAppId,
        instanceId: target.durableInstanceId,
        runtimeSandboxName: target.runtimeSandboxName,
      })
      .catch(() => "unknown" as const);
    const decision: SessionRuntimeProvisioningReconcileDecision = {
      sessionId: target.sessionId,
      instanceId: target.durableInstanceId,
      state,
      outcome: state === "unknown" ? "unknown" : "superseded",
      executed: false,
    };

    if (state === "unknown") {
      decisions.push(decision);
      continue;
    }
    if (options.dryRun) {
      decisions.push(decision);
      continue;
    }
    if (actionsTaken >= options.maxActionsPerRun) {
      decision.outcome = "action_cap_reached";
      decisions.push(decision);
      continue;
    }

    actionsTaken += 1;
    decision.executed = true;
    try {
      if (state === "active") {
        const attached =
          await deps.store.attachStagedSessionRuntimeProvisioning(
            exactLease(target),
          );
        if (attached) {
          await ensureOwnedPublishedRuntimeHost(deps, target);
        }
        const completion = attached
          ? await deps.store.completeStagedSessionRuntimeProvisioning({
              sessionId: target.sessionId,
              expectedStartedAt: target.startedAt,
              runtimeAppId: target.runtimeAppId,
            })
          : "superseded";
        decision.outcome =
          completion === "completed" || completion === "already_completed"
            ? "attached_active"
            : "superseded";
        decisions.push(decision);
        continue;
      }
      if (target.publishedGeneration) {
        if (target.runtimeHostOwned) {
          await ensureOwnedPublishedRuntimeHost(deps, target);
        }
        const completion =
          await deps.store.completeStagedSessionRuntimeProvisioning({
            sessionId: target.sessionId,
            expectedStartedAt: target.startedAt,
            runtimeAppId: target.runtimeAppId,
          });
        decision.outcome =
          completion === "completed" || completion === "already_completed"
            ? "recovered_published_generation"
            : "superseded";
        decisions.push(decision);
        continue;
      }

      const claimedAt = new Date(
        Math.max(deps.now(), target.startedAt.getTime() + 1),
      );
      const claimedTarget = { ...target, startedAt: claimedAt };
      const claimed = await deps.store.claimStaleSessionRuntimeProvisioning({
        current: target,
        claimedAt,
      });
      if (!claimed) {
        decision.outcome = "superseded";
        decisions.push(decision);
        continue;
      }
      if (state === "terminal") {
        await deps.runtimeCleaner.purgeRuntimeInstance({
          runtimeAppId: target.runtimeAppId,
          instanceId: target.durableInstanceId,
          runtimeSandboxName: target.runtimeSandboxName,
        });
      }
      // A positive durable not-found is sufficient to skip purge, but an owned
      // generation host still must be reaped before the exact generation is
      // prepared for a fresh redrive. The old identity remains durable until
      // cleanup succeeds, so a crashed claimant cannot orphan it.
      await deleteOwnedRuntimeHost(deps, target);
      const replacementGeneration = deps.generationFactory.createReplacement({
        current: target,
        startedAt: claimedAt,
      });
      const replacement: StaleSessionRuntimeProvisioningTarget = {
        ...target,
        ...replacementGeneration,
        startedAt: claimedAt,
        publishedGeneration: false,
      };
      const prepared =
        await deps.store.prepareClaimedSessionRuntimeProvisioningRedrive({
          claimed: claimedTarget,
          replacement,
        });
      if (!prepared) {
        decision.outcome = "superseded";
        decisions.push(decision);
        continue;
      }
      const redriven = await deps.redriveSession(replacement);
      if (redriven.instanceId !== replacement.durableInstanceId) {
        throw new Error(
          `runtime recovery changed generation from ${replacement.durableInstanceId} to ${redriven.instanceId}`,
        );
      }
      decision.replacementInstanceId = redriven.instanceId;
      decision.outcome =
        state === "terminal" ? "redriven_terminal" : "redriven_missing";
    } catch (error) {
      decision.outcome = "error";
      decision.error = error instanceof Error ? error.message : String(error);
    }
    decisions.push(decision);
  }

  return {
    scanned: targets.length,
    actionsTaken,
    dryRun: options.dryRun,
    decisions,
  };
}
