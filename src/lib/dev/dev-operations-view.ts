import type {
  VclusterPreviewCounts,
  VclusterPreviewProfile,
  VclusterPreviewSummary,
} from "$lib/types/dev-previews";

export type DevSessionLike = {
  ready: boolean;
  runStatus: string | null;
};

export type DevSessionGroupLike = {
  primary: DevSessionLike;
};

export type DevOperationsSummary = {
  ready: number;
  provisioning: number;
  attention: number;
  liveSessions: number;
  previewCapacity: string;
};

export const PREVIEW_RUNTIME_PROVISIONING_POLL_MS = 3_000;
export const PREVIEW_RUNTIME_STABLE_POLL_MS = 15_000;

type PreviewRuntimePollingPreview = Pick<
  VclusterPreviewSummary,
  "phase" | "ready" | "state"
>;

type PreviewRuntimePollingObservation = {
  reconciliationSucceeded: boolean;
  provision: {
    active: boolean;
    failed: boolean;
    succeeded: boolean;
  };
};

const FAILED_PHASES = new Set(["error", "failed", "capacity_full"]);
const SESSION_ATTENTION_STATUSES = new Set(["error", "failed", "cancelled"]);
const SESSION_TERMINAL_STATUSES = new Set([
  ...SESSION_ATTENTION_STATUSES,
  "completed",
  "success",
  "terminated",
]);
const TRANSITION_PHASES = new Set([
  "claiming",
  "pending",
  "provisioning",
  "recycling",
  "resuming",
  "seeding",
  "starting",
  "terminating",
]);

export function summarizeDevOperations(
  previews: readonly VclusterPreviewSummary[],
  groups: readonly DevSessionGroupLike[],
  counts: VclusterPreviewCounts | null,
): DevOperationsSummary {
  const readyPreviews = previews.filter(
    (preview) =>
      preview.ready &&
      preview.state !== "slept" &&
      !FAILED_PHASES.has(preview.phase),
  ).length;
  const readySessions = groups.filter(
    (group) =>
      group.primary.ready &&
      !SESSION_ATTENTION_STATUSES.has(
        (group.primary.runStatus ?? "").toLowerCase(),
      ),
  ).length;
  const provisioningPreviews = previews.filter(
    (preview) =>
      preview.state !== "slept" &&
      !preview.ready &&
      !FAILED_PHASES.has(preview.phase) &&
      (preview.phase === "unknown" || TRANSITION_PHASES.has(preview.phase)),
  ).length;
  const provisioningSessions = groups.filter(
    (group) =>
      !group.primary.ready &&
      !SESSION_TERMINAL_STATUSES.has(
        (group.primary.runStatus ?? "").toLowerCase(),
      ),
  ).length;
  const failedPreviews = previews.filter((preview) =>
    FAILED_PHASES.has(preview.phase),
  ).length;
  const failedSessions = groups.filter(
    (group) =>
      SESSION_ATTENTION_STATUSES.has(
        (group.primary.runStatus ?? "").toLowerCase(),
      ),
  ).length;

  return {
    ready: readyPreviews + readySessions,
    provisioning: provisioningPreviews + provisioningSessions,
    attention: failedPreviews + failedSessions,
    liveSessions: groups.length,
    previewCapacity: counts ? `${counts.awake}/${counts.max || "-"}` : "-",
  };
}

export function previewProfileLabel(
  profile: VclusterPreviewProfile | null,
): string {
  switch (profile) {
    case "app-live":
      return "Application development";
    case "manifest-candidate":
      return "Infrastructure candidate";
    case "host-candidate":
      return "Host candidate";
    default:
      return "Legacy preview";
  }
}

export function previewDeliveryLabel(
  preview: Pick<VclusterPreviewSummary, "mode" | "origin">,
): string {
  if (
    preview.mode === "reconciled" ||
    preview.origin?.kind === "pull-request"
  ) {
    return "Git-reconciled candidate";
  }
  return "Uncommitted preview state";
}

export function previewGitOpsHref(
  preview: Pick<VclusterPreviewSummary, "mode" | "origin" | "services">,
): string | null {
  if (preview.mode !== "reconciled" && preview.origin?.kind !== "pull-request")
    return null;
  const service = preview.services?.[0];
  return service
    ? `/admin/gitops?tab=services&service=${encodeURIComponent(service)}`
    : "/admin/gitops?tab=overview";
}

export function formatBootElapsed(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

/**
 * Runtime observations are relatively hot while a preview is converging and
 * intentionally quiet once it is stable. This controls only the authorized
 * application read endpoint; it does not infer Kubernetes progress.
 */
export function previewRuntimePollInterval(
  preview: PreviewRuntimePollingPreview,
  runtime: PreviewRuntimePollingObservation | null,
): number {
  const phase = preview.phase.toLowerCase();
  const terminalFailure =
    FAILED_PHASES.has(phase) || runtime?.provision.failed === true;
  const transitioning =
    preview.state !== "slept" &&
    !terminalFailure &&
    (!preview.ready ||
      TRANSITION_PHASES.has(phase) ||
      runtime?.provision.active === true ||
      (runtime !== null &&
        !runtime.reconciliationSucceeded &&
        !runtime.provision.succeeded));

  return transitioning
    ? PREVIEW_RUNTIME_PROVISIONING_POLL_MS
    : PREVIEW_RUNTIME_STABLE_POLL_MS;
}
