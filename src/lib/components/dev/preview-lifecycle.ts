import { resolveStatusTone, type StatusTone } from "$lib/utils/status-tone";
import type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewSummary,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";

/** A relative "…ago" label for a past timestamp (lastActive). Null for
 * absent/garbage input. */
export function relativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleDateString();
}

export type ExpiryInfo = {
  /** e.g. "expires in 45m" / "expires in 3h" / "expired". */
  label: string;
  /** True under an hour to go (or expired) → the UI renders it amber. */
  urgent: boolean;
  expired: boolean;
};

/** A countdown to a preview's TTL expiry. Null when there is no expiry (a
 * legacy/human preview is never auto-reaped). */
export function expiresIn(
  iso: string | null | undefined,
  now: number = Date.now(),
): ExpiryInfo | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  if (diff <= 0) return { label: "expired", urgent: true, expired: true };
  const mins = Math.floor(diff / 60_000);
  if (mins < 60)
    return { label: `expires in ${mins}m`, urgent: true, expired: false };
  const hours = Math.floor(mins / 60);
  if (hours < 24)
    return { label: `expires in ${hours}h`, urgent: false, expired: false };
  return {
    label: `expires in ${Math.floor(hours / 24)}d`,
    urgent: false,
    expired: false,
  };
}

type PreviewLike = Pick<
  VclusterPreviewSummary,
  "phase" | "state" | "protected" | "pool" | "origin"
>;

/** The status string that drives the row badge: a slept preview reads "slept"
 * even if its underlying Job phase still says "ready". */
export function effectivePreviewStatus(
  preview: Pick<PreviewLike, "phase" | "state">,
): string {
  return preview.state === "slept" ? "slept" : preview.phase;
}

/** The shared tone for a preview's effective status (feeds the pill/meter). */
export function phaseTone(
  preview: Pick<PreviewLike, "phase" | "state">,
): StatusTone {
  return resolveStatusTone(effectivePreviewStatus(preview));
}

/** Copy boundary for the asynchronous teardown acceptance response. */
export function previewTeardownOutcome(
  phase: string,
): "torn down" | "teardown started" {
  return phase === "absent" ? "torn down" : "teardown started";
}

const TEARDOWN_CHECK_LABELS: ReadonlyArray<
  readonly [keyof VclusterPreviewCleanupSnapshot["checks"], string]
> = [
  ["runnerSucceeded", "Waiting for teardown runner"],
  ["databaseAbsent", "Removing preview database"],
  ["natsStreamAbsent", "Removing preview event stream"],
  ["tailnetEgressAbsent", "Removing tailnet access"],
  ["hostNamespaceAbsent", "Removing workload namespace"],
  ["storageScopeAbsent", "Releasing preview storage"],
  ["runnerIdentityAbsent", "Revoking runner identity"],
  ["applicationAbsent", "Removing Argo CD application"],
  ["agentRegistrationAbsent", "Removing Argo CD agent registration"],
  ["agentNamespacesAbsent", "Removing agent namespaces"],
  ["headlampRegistrationAbsent", "Removing Headlamp registration"],
  ["previewEnvironmentAbsent", "Finalizing environment record"],
];

export type PreviewTeardownProgressView = Readonly<{
  completed: number;
  total: number;
  percent: number;
  label: string;
  failed: boolean;
}>;

/** Stable presentation model for controller cleanup checks. */
export function previewTeardownProgress(
  snapshot: VclusterPreviewCleanupSnapshot,
): PreviewTeardownProgressView {
  const completed = TEARDOWN_CHECK_LABELS.filter(
    ([check]) => snapshot.checks[check],
  ).length;
  const total = TEARDOWN_CHECK_LABELS.length;
  const next = TEARDOWN_CHECK_LABELS.find(
    ([check]) => !snapshot.checks[check],
  );
  return {
    completed,
    total,
    percent: snapshot.complete ? 100 : Math.round((completed / total) * 100),
    label:
      snapshot.phase === "complete"
        ? "Cleanup complete"
        : snapshot.phase === "failed"
          ? snapshot.message || "Cleanup needs attention"
          : (next?.[1] ?? "Finalizing cleanup"),
    failed: snapshot.phase === "failed",
  };
}

/** Retain an accepted teardown row after SEA stops listing its namespace. */
export function previewsWithAcceptedTeardowns(
  previews: readonly VclusterPreviewSummary[],
  accepted: readonly VclusterPreviewSummary[],
): VclusterPreviewSummary[] {
  const current = new Set(previews.map((preview) => preview.name));
  return [
    ...previews,
    ...accepted.filter((preview) => !current.has(preview.name)),
  ];
}

export function previewTeardownStatusPath(
  ticket: VclusterPreviewTeardownTicket,
): string {
  const query = new URLSearchParams({
    environmentUid: ticket.environmentUid,
    requestId: ticket.requestId,
    sourceRevision: ticket.sourceRevision,
    signature: ticket.signature,
  });
  return `/api/dev-environments/vcluster/${encodeURIComponent(ticket.name)}/teardown/status?${query}`;
}

/**
 * Why the Sleep action is disabled for a preview (null = allowed). Mirrors the
 * SEA sleep 409 contract: protected previews and legacy pool-backed records
 * refuse, and PR previews are torn down by their PR closing rather than slept
 * by hand. New PreviewEnvironments are always cold allocated.
 */
export function sleepDisabledReason(
  preview: Partial<
    Pick<PreviewLike, "state" | "protected" | "pool" | "origin">
  >,
): string | null {
  if (preview.state === "slept") return "Already sleeping";
  if (preview.protected)
    return "Protected preview — exempt from sleep/eviction";
  if (preview.pool) return "Legacy pool-backed preview cannot be slept";
  if (preview.origin?.kind === "pull-request")
    return "PR previews sleep automatically when the PR closes";
  return null;
}
