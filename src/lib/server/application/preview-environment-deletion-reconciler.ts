import {
  PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS,
  type PreviewEnvironmentDeletionAcknowledgement,
  type PreviewEnvironmentCleanupReceiptPort,
  type PreviewEnvironmentDeletionIntent,
  type PreviewEnvironmentDeletionOutboxPort,
  type PreviewRuntimeBudgetCleanupPort,
  type VclusterPreviewCleanupSnapshot,
  type VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";

export type PreviewEnvironmentDeletionReconcileResult = Readonly<{
  scanned: number;
  acknowledged: number;
  pending: number;
  failed: number;
  prunedReceipts: number;
  pruneFailed: number;
  prunedRuntimeBudgets: number;
  runtimeBudgetPruneFailed: number;
  items: readonly Readonly<{
    name: string;
    intentId: string;
    state: "acknowledged" | "pending" | "failed";
    message: string | null;
  }>[];
}>;

/**
 * Dev-side consumer for hub deletion intents.
 *
 * The hub controller never receives dev credentials. It persists an immutable
 * intent on the CR; this service crosses the existing SEA adapter, verifies the
 * exact down-runner receipt, and writes only the tuple-bound acknowledgement.
 */
export class ApplicationPreviewEnvironmentDeletionReconcilerService {
  constructor(
    private readonly options: Readonly<{
      outbox: PreviewEnvironmentDeletionOutboxPort;
      gateway: Pick<VclusterPreviewGatewayPort, "teardown" | "cleanup">;
      runtimeBudgets: PreviewRuntimeBudgetCleanupPort;
      runtimeBudgetRetentionHours: number;
      runtimeBudgetPruneLimit: number;
      receipts?: PreviewEnvironmentCleanupReceiptPort;
      now?: () => Date;
    }>,
  ) {}

  async reconcile(): Promise<PreviewEnvironmentDeletionReconcileResult> {
    const intents = await this.options.outbox.listPending();
    const items: Array<
      PreviewEnvironmentDeletionReconcileResult["items"][number]
    > = [];
    for (const intent of intents) {
      try {
        const state = await this.reconcileOne(intent);
        items.push({
          name: intent.name,
          intentId: intent.id,
          state,
          message: null,
        });
      } catch (cause) {
        items.push({
          name: intent.name,
          intentId: intent.id,
          state: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    let prunedReceipts = 0;
    let pruneFailed = 0;
    let prunedRuntimeBudgets = 0;
    let runtimeBudgetPruneFailed = 0;
    if (this.options.receipts) {
      for (const receipt of await this.options.receipts.list()) {
        try {
          if (!(await this.options.outbox.absent(receipt.name))) continue;
          await this.options.receipts.release(receipt);
          prunedReceipts += 1;
        } catch {
          pruneFailed += 1;
        }
      }
    }
    try {
      prunedRuntimeBudgets = await this.options.runtimeBudgets.pruneExpired(
        this.options.runtimeBudgetPruneLimit,
      );
    } catch {
      runtimeBudgetPruneFailed = 1;
    }
    return {
      scanned: items.length,
      acknowledged: items.filter((item) => item.state === "acknowledged")
        .length,
      pending: items.filter((item) => item.state === "pending").length,
      failed: items.filter((item) => item.state === "failed").length,
      prunedReceipts,
      pruneFailed,
      prunedRuntimeBudgets,
      runtimeBudgetPruneFailed,
      items,
    };
  }

  private async reconcileOne(
    intent: PreviewEnvironmentDeletionIntent,
  ): Promise<"acknowledged" | "pending"> {
    let cleanup = await this.options.gateway.cleanup(intent.name);
    if (!cleanup.complete) {
      await this.options.gateway.teardown(intent.name, {
        mode: "owned",
        requestId: intent.requestId,
        sourceRevision: intent.sourceRevision,
        // A Kubernetes deletion intent is the platform-authoritative destructive
        // command. The archive token never crosses into the runner.
        archiveConfirmed: true,
        deletionIntent: {
          id: intent.id,
          environmentUid: intent.environmentUid,
        },
      });
      cleanup = await this.options.gateway.cleanup(intent.name);
    }
    if (!cleanup.complete) return "pending";

    const acknowledgement = this.acknowledgement(intent, cleanup);
    await this.options.runtimeBudgets.close({
      identity: {
        previewName: intent.name,
        environmentRequestId: intent.requestId,
        environmentPlatformRevision: intent.platformRevision,
        environmentSourceRevision: intent.sourceRevision,
        catalogDigest: intent.catalogDigest,
      },
      retentionHours: this.options.runtimeBudgetRetentionHours,
    });
    await this.options.outbox.acknowledge(intent, acknowledgement);
    return "acknowledged";
  }

  private acknowledgement(
    intent: PreviewEnvironmentDeletionIntent,
    cleanup: VclusterPreviewCleanupSnapshot,
  ): PreviewEnvironmentDeletionAcknowledgement {
    const proof = cleanup.teardownProof;
    if (
      cleanup.resourceName !== intent.name ||
      !proof ||
      proof.intentId !== intent.id ||
      proof.environmentUid !== intent.environmentUid ||
      proof.requestId !== intent.requestId ||
      proof.sourceRevision !== intent.sourceRevision ||
      proof.jobName !== `vcpreview-down-${intent.name}` ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(proof.jobUid) ||
      !/^op:[0-9a-f]{32}$/.test(proof.runnerGeneration)
    ) {
      throw new Error("SEA cleanup proof does not match the deletion intent");
    }
    const checks = Object.fromEntries(
      PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS.map((name) => {
        if (cleanup.checks[name] !== true) {
          throw new Error(`SEA cleanup proof is incomplete: ${name}`);
        }
        return [name, true] as const;
      }),
    ) as PreviewEnvironmentDeletionAcknowledgement["checks"];
    return {
      intentId: intent.id,
      environmentUid: intent.environmentUid,
      requestId: intent.requestId,
      platformRevision: intent.platformRevision,
      sourceRevision: intent.sourceRevision,
      catalogDigest: intent.catalogDigest,
      observedAt: (this.options.now?.() ?? new Date()).toISOString(),
      resourceName: cleanup.resourceName,
      runner: {
        jobName: proof.jobName,
        jobUid: proof.jobUid,
        generation: proof.runnerGeneration,
      },
      checks,
    };
  }
}
