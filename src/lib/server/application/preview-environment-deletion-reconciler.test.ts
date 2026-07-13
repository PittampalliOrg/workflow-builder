import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewEnvironmentDeletionReconcilerService } from "$lib/server/application/preview-environment-deletion-reconciler";
import type {
  PreviewEnvironmentDeletionIntent,
  PreviewEnvironmentDeletionOutboxPort,
  VclusterPreviewCleanupSnapshot,
} from "$lib/server/application/ports";

const intent: PreviewEnvironmentDeletionIntent = {
  id: `sha256:${"a".repeat(64)}`,
  name: "feature-one",
  environmentUid: "12345678-1234-1234-1234-123456789abc",
  requestId: "request-1",
  platformRevision: "a".repeat(
    40,
  ) as PreviewEnvironmentDeletionIntent["platformRevision"],
  sourceRevision: "b".repeat(
    40,
  ) as PreviewEnvironmentDeletionIntent["sourceRevision"],
  catalogDigest: `sha256:${"c".repeat(64)}`,
  deletionTimestamp: "2026-07-10T12:00:00.000Z",
};

function cleanup(complete: boolean): VclusterPreviewCleanupSnapshot {
  return {
    name: intent.name,
    resourceName: intent.name,
    complete,
    phase: complete ? "complete" : "pending",
    checks: {
      runnerSucceeded: complete,
      previewEnvironmentAbsent: false,
      applicationAbsent: complete,
      agentRegistrationAbsent: complete,
      agentNamespacesAbsent: complete,
      databaseAbsent: complete,
      natsStreamAbsent: complete,
      headlampRegistrationAbsent: complete,
      tailnetEgressAbsent: complete,
      hostNamespaceAbsent: complete,
      storageScopeAbsent: complete,
      runnerIdentityAbsent: complete,
    },
    ...(complete
      ? {
          teardownProof: {
            intentId: intent.id,
            environmentUid: intent.environmentUid,
            requestId: intent.requestId,
            sourceRevision: intent.sourceRevision,
            jobName: "vcpreview-down-feature-one",
            jobUid: "87654321-4321-4321-4321-cba987654321",
            runnerGeneration: `op:${"c".repeat(32)}` as const,
          },
        }
      : {}),
    message: null,
  };
}

function outbox() {
  return {
    listPending: vi.fn(async () => [intent]),
    acknowledge: vi.fn(async () => undefined),
    absent: vi.fn(async () => false),
  } satisfies PreviewEnvironmentDeletionOutboxPort;
}

function runtimeBudgets() {
  return {
    close: vi.fn(async () => undefined),
    pruneExpired: vi.fn(async () => 0),
  };
}

describe("ApplicationPreviewEnvironmentDeletionReconcilerService", () => {
  it("submits exact SEA down and acks only after physical absence proof", async () => {
    const store = outbox();
    const gateway = {
      cleanup: vi
        .fn()
        .mockResolvedValueOnce(cleanup(false))
        .mockResolvedValueOnce(cleanup(true)),
      teardown: vi.fn(async () => ({ name: intent.name })),
    };
    const budgets = runtimeBudgets();
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: gateway as never,
      runtimeBudgets: budgets,
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
      now: () => new Date("2026-07-10T12:01:00.000Z"),
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      scanned: 1,
      acknowledged: 1,
      failed: 0,
    });
    expect(gateway.teardown).toHaveBeenCalledWith(intent.name, {
      mode: "owned",
      requestId: intent.requestId,
      sourceRevision: intent.sourceRevision,
      archiveConfirmed: true,
      deletionIntent: intent,
    });
    expect(store.acknowledge).toHaveBeenCalledWith(
      intent,
      expect.objectContaining({
        intentId: intent.id,
        environmentUid: intent.environmentUid,
        platformRevision: intent.platformRevision,
        catalogDigest: intent.catalogDigest,
        observedAt: "2026-07-10T12:01:00.000Z",
        runner: {
          generation: `op:${"c".repeat(32)}`,
          jobName: expect.any(String),
          jobUid: expect.any(String),
        },
      }),
    );
    expect(budgets.close).toHaveBeenCalledWith({
      identity: {
        previewName: intent.name,
        environmentRequestId: intent.requestId,
        environmentPlatformRevision: intent.platformRevision,
        environmentSourceRevision: intent.sourceRevision,
        catalogDigest: intent.catalogDigest,
      },
      retentionHours: 192,
    });
    expect(budgets.close.mock.invocationCallOrder[0]).toBeLessThan(
      store.acknowledge.mock.invocationCallOrder[0],
    );
  });

  it("survives a crash after SEA deletion and retries close plus durable ack", async () => {
    const store = outbox();
    store.acknowledge.mockRejectedValueOnce(
      new Error("broker process terminated"),
    );
    const gateway = {
      cleanup: vi.fn(async () => cleanup(true)),
      teardown: vi.fn(),
    };
    const budgets = runtimeBudgets();
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: gateway as never,
      runtimeBudgets: budgets,
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
    });

    await expect(service.reconcile()).resolves.toMatchObject({ failed: 1 });
    const restarted =
      new ApplicationPreviewEnvironmentDeletionReconcilerService({
        outbox: store,
        gateway: gateway as never,
        runtimeBudgets: budgets,
        runtimeBudgetRetentionHours: 192,
        runtimeBudgetPruneLimit: 100,
      });
    await expect(restarted.reconcile()).resolves.toMatchObject({
      acknowledged: 1,
    });
    expect(gateway.teardown).not.toHaveBeenCalled();
    expect(store.acknowledge).toHaveBeenCalledTimes(2);
    expect(budgets.close).toHaveBeenCalledTimes(2);
  });

  it("refuses stale or non-exact SEA receipts", async () => {
    const store = outbox();
    const stale = cleanup(true);
    stale.teardownProof = {
      ...stale.teardownProof!,
      environmentUid: "different",
    };
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: {
        cleanup: vi.fn(async () => stale),
        teardown: vi.fn(),
      } as never,
      runtimeBudgets: runtimeBudgets(),
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      failed: 1,
      acknowledged: 0,
    });
    expect(store.acknowledge).not.toHaveBeenCalled();
  });

  it("does not acknowledge teardown until the exact runtime budget is closed", async () => {
    const store = outbox();
    const budgets = runtimeBudgets();
    budgets.close.mockRejectedValueOnce(new Error("budget close failed"));
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: {
        cleanup: vi.fn(async () => cleanup(true)),
        teardown: vi.fn(),
      } as never,
      runtimeBudgets: budgets,
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      failed: 1,
      acknowledged: 0,
    });
    expect(store.acknowledge).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong resource", { resourceName: "another-preview" }],
    ["wrong job", { jobName: "vcpreview-down-another-preview" }],
  ] as Array<[string, { resourceName?: string; jobName?: string }]>)(
    "does not acknowledge a %s receipt",
    async (_case, change) => {
      const store = outbox();
      const stale = cleanup(true);
      if (change.resourceName) stale.resourceName = change.resourceName;
      if (change.jobName) {
        stale.teardownProof = {
          ...stale.teardownProof!,
          jobName: change.jobName,
        };
      }
      const service =
        new ApplicationPreviewEnvironmentDeletionReconcilerService({
          outbox: store,
          gateway: {
            cleanup: vi.fn(async () => stale),
            teardown: vi.fn(),
          } as never,
          runtimeBudgets: runtimeBudgets(),
          runtimeBudgetRetentionHours: 192,
          runtimeBudgetPruneLimit: 100,
        });

      await expect(service.reconcile()).resolves.toMatchObject({
        failed: 1,
        acknowledged: 0,
      });
      expect(store.acknowledge).not.toHaveBeenCalled();
    },
  );

  it("prunes a retained down receipt only after hub CR finalization", async () => {
    const store = outbox();
    store.listPending.mockResolvedValue([]);
    store.absent.mockResolvedValue(true);
    const receipt = {
      name: intent.name,
      jobName: "vcpreview-down-feature-one",
      jobUid: "87654321-4321-4321-4321-cba987654321",
      runnerGeneration: `op:${"c".repeat(32)}` as const,
    };
    const receipts = {
      list: vi.fn(async () => [receipt]),
      release: vi.fn(async () => undefined),
    };
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: { cleanup: vi.fn(), teardown: vi.fn() } as never,
      runtimeBudgets: runtimeBudgets(),
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
      receipts,
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      prunedReceipts: 1,
      pruneFailed: 0,
    });
    expect(store.absent).toHaveBeenCalledWith(intent.name);
    expect(receipts.release).toHaveBeenCalledWith(receipt);
  });

  it("reports bounded runtime-budget tombstone pruning", async () => {
    const store = outbox();
    store.listPending.mockResolvedValue([]);
    const budgets = runtimeBudgets();
    budgets.pruneExpired.mockResolvedValue(7);
    const service = new ApplicationPreviewEnvironmentDeletionReconcilerService({
      outbox: store,
      gateway: { cleanup: vi.fn(), teardown: vi.fn() } as never,
      runtimeBudgets: budgets,
      runtimeBudgetRetentionHours: 192,
      runtimeBudgetPruneLimit: 100,
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      prunedRuntimeBudgets: 7,
      runtimeBudgetPruneFailed: 0,
    });
    expect(budgets.pruneExpired).toHaveBeenCalledWith(100);
  });
});
