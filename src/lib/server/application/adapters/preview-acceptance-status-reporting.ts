import type { PreviewGovernanceStatusMode } from "$lib/server/application/config";
import type {
  PreviewAcceptanceCommitStatusPort,
  PreviewGateReconcilerPort,
} from "$lib/server/application/ports";

export type PreviewAcceptanceStatusReporting = Readonly<{
  statuses: PreviewAcceptanceCommitStatusPort;
  gate: PreviewGateReconcilerPort;
}>;

const POC_ACCEPTANCE_STATUSES: PreviewAcceptanceCommitStatusPort =
  Object.freeze({
    async publish(): Promise<void> {},
    async latest() {
      return Object.freeze({
        "preview/immutable-acceptance": null,
        "preview/activation-images": null,
      });
    },
  });

const POC_ACCEPTANCE_GATE: PreviewGateReconcilerPort = Object.freeze({
  async reconcile(): Promise<void> {},
});

const POC_ACCEPTANCE_STATUS_REPORTING: PreviewAcceptanceStatusReporting =
  Object.freeze({
    statuses: POC_ACCEPTANCE_STATUSES,
    gate: POC_ACCEPTANCE_GATE,
  });

/**
 * The development POC deliberately omits only immutable-acceptance status
 * publication and aggregate gate reconciliation. GitHub reads, source writes,
 * receipts, and every non-acceptance governance path retain their own adapters.
 */
export function resolvePreviewAcceptanceStatusReporting(
  mode: PreviewGovernanceStatusMode,
  strict: () => PreviewAcceptanceStatusReporting,
): PreviewAcceptanceStatusReporting {
  return mode === "poc" ? POC_ACCEPTANCE_STATUS_REPORTING : strict();
}
