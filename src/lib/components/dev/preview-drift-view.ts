/**
 * Pure presentation model for the Dev-hub drift surfaces (U2). Maps the
 * `getPreviewDriftOverview` contract (`PreviewDriftOverview` /
 * `PreviewDriftEntry`) into stable badge metadata, fleet summary counts,
 * revert-risk assessments, and deep links. No I/O, no Svelte — unit-tested
 * directly by `preview-drift-view.test.ts`.
 */
import type {
  PreviewDriftEntry,
  PreviewDriftOverview,
  PreviewPromotionReceiptSummary,
  PreviewServiceDrift,
  PreviewServiceDriftStatus,
  PreviewStage,
  VclusterPreviewSummary,
} from "$lib/types/dev-previews";

/* ── Drift status badges ─────────────────────────────────────────────── */

export type DriftStatusMeta = {
  label: string;
  /** Chip classes (border + bg + text, both themes). */
  badgeClass: string;
  /** Legend/summary dot. */
  dotClass: string;
  /** Tooltip copy explaining exactly what this verdict means. */
  description: string;
  /** Sort weight for summaries — most severe first. */
  severity: number;
};

export const DRIFT_STATUS_META: Record<PreviewServiceDriftStatus, DriftStatusMeta> = {
  diverged: {
    label: "Diverged",
    badgeClass:
      "border-destructive/40 bg-destructive/10 text-destructive dark:text-red-400",
    dotClass: "bg-destructive",
    description:
      "The running image is neither the current dev release pin nor any known historical pin — usually an agent-built candidate image. Promote or revert before relying on this environment.",
    severity: 0,
  },
  "behind-pin": {
    label: "Behind pin",
    badgeClass:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    dotClass: "bg-amber-500",
    description:
      "The running image is a known historical pin but not the current one — the preview has not rolled forward to the latest dev release pin yet.",
    severity: 1,
  },
  "pin-behind-main": {
    label: "Pin behind main",
    badgeClass:
      "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    dotClass: "bg-sky-500",
    description:
      "The running image matches the current dev release pin, but the pin's source commit is not workflow-builder main HEAD — a newer build exists upstream.",
    severity: 2,
  },
  unknown: {
    label: "Unknown",
    badgeClass: "border-border bg-muted text-muted-foreground",
    dotClass: "bg-muted-foreground/50",
    description:
      "Not enough data to classify — the preview is slept, its runtime was unreadable, or no release pin exists for this service.",
    severity: 3,
  },
  "in-sync": {
    label: "In sync",
    badgeClass:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    dotClass: "bg-emerald-500",
    description:
      "The running image matches the current dev release pin, and the pin is built from workflow-builder main HEAD.",
    severity: 4,
  },
};

/* ── Dev-cycle stage badges ──────────────────────────────────────────── */

/** Number of dots in the stage-progress affordance. */
export const STAGE_STEP_TOTAL = 4;

export type StageMeta = {
  label: string;
  badgeClass: string;
  /** Filled-dot count in the 4-step progress affordance; null = out-of-cycle
   * states (sleeping/failed) that render state color instead of progress. */
  step: number | null;
  description: string;
};

/**
 * Stage presentation. Step semantics: 1 provision → 2 environment ready
 * (ready/retained both "at rest") → 3 agent editing → 4 promoted.
 */
export const STAGE_META: Record<PreviewStage, StageMeta> = {
  provisioning: {
    label: "Provisioning",
    badgeClass:
      "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
    step: 1,
    description: "The environment is being provisioned or reclaimed.",
  },
  ready: {
    label: "Ready",
    badgeClass:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    step: 2,
    description: "The environment is up with no active agent session or promotion yet.",
  },
  retained: {
    label: "Retained",
    badgeClass: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
    step: 2,
    description:
      "A long-lived retained environment at rest — kept after its run completed.",
  },
  "agent-editing": {
    label: "Agent editing",
    badgeClass:
      "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
    step: 3,
    description: "A dev sandbox session is actively editing sources in this environment.",
  },
  promoted: {
    label: "Promoted",
    badgeClass:
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    step: 4,
    description: "Work from this environment has been captured into a draft pull request.",
  },
  sleeping: {
    label: "Sleeping",
    badgeClass:
      "border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
    step: null,
    description: "Scaled to zero — wake it to resume. Compute is released while slept.",
  },
  failed: {
    label: "Failed",
    badgeClass: "border-destructive/40 bg-destructive/10 text-destructive dark:text-red-400",
    step: null,
    description: "The environment reports a failed lifecycle phase and needs attention.",
  },
};

/* ── Fleet drift summary (header chips) ──────────────────────────────── */

export type DriftSummaryCounts = {
  inSync: number;
  behindPin: number;
  pinBehindMain: number;
  diverged: number;
  unknown: number;
  /** Total classified service rows. */
  services: number;
  previews: number;
};

/** Aggregate every per-service verdict across the fleet's previews. */
export function summarizeDriftOverview(
  overview: Pick<PreviewDriftOverview, "previews"> | null | undefined,
): DriftSummaryCounts | null {
  if (!overview) return null;
  const counts: DriftSummaryCounts = {
    inSync: 0,
    behindPin: 0,
    pinBehindMain: 0,
    diverged: 0,
    unknown: 0,
    services: 0,
    previews: overview.previews.length,
  };
  for (const preview of overview.previews) {
    for (const service of preview.services) {
      counts.services += 1;
      switch (service.driftStatus) {
        case "in-sync":
          counts.inSync += 1;
          break;
        case "behind-pin":
          counts.behindPin += 1;
          break;
        case "pin-behind-main":
          counts.pinBehindMain += 1;
          break;
        case "diverged":
          counts.diverged += 1;
          break;
        default:
          counts.unknown += 1;
      }
    }
  }
  return counts;
}

export type DriftSummaryChip = {
  status: PreviewServiceDriftStatus;
  label: string;
  count: number;
  badgeClass: string;
  dotClass: string;
  description: string;
};

/** Non-zero summary chips, most severe first (diverged → … → in-sync). */
export function driftSummaryChips(counts: DriftSummaryCounts | null): DriftSummaryChip[] {
  if (!counts || counts.services === 0) return [];
  const byStatus: Array<[PreviewServiceDriftStatus, number]> = [
    ["diverged", counts.diverged],
    ["behind-pin", counts.behindPin],
    ["pin-behind-main", counts.pinBehindMain],
    ["unknown", counts.unknown],
    ["in-sync", counts.inSync],
  ];
  return byStatus
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => DRIFT_STATUS_META[a].severity - DRIFT_STATUS_META[b].severity)
    .map(([status, count]) => ({
      status,
      count,
      label: DRIFT_STATUS_META[status].label,
      badgeClass: DRIFT_STATUS_META[status].badgeClass,
      dotClass: DRIFT_STATUS_META[status].dotClass,
      description: DRIFT_STATUS_META[status].description,
    }));
}

/* ── Version chips ───────────────────────────────────────────────────── */

/** `sha256:abcdef…` → `abcdef123456` (12 chars); tolerant of bare digests. */
export function shortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  const bare = digest.replace(/^sha256:/, "");
  return bare ? bare.slice(0, 12) : null;
}

export function shortSha(sha: string | null | undefined, length = 7): string | null {
  if (!sha) return null;
  return sha.slice(0, length);
}

export type VersionChip = { label: string; title: string };

/** Running-version chip: prefer the image tag, fall back to the digest. */
export function runningVersionChip(row: PreviewServiceDrift): VersionChip | null {
  if (!row.running) return null;
  const label = row.running.tag ?? shortDigest(row.running.digest) ?? "unversioned";
  return { label, title: row.running.image };
}

/** Pin-version chip for the same service row. */
export function pinVersionChip(row: PreviewServiceDrift): VersionChip | null {
  if (!row.pin) return null;
  const label = row.pin.tag ?? shortDigest(row.pin.digest);
  if (!label) return null;
  const source = row.pin.commitSha ? ` (source ${shortSha(row.pin.commitSha) ?? ""})` : "";
  return { label, title: `dev release pin ${label}${source}` };
}

/* ── Revert-risk warnings ────────────────────────────────────────────── */

/**
 * Receipt summary with the OPTIONAL `changedPaths` enrichment. The shared
 * contract carries {prNumber, prUrl, commitSha, createdAt}; the durable table
 * also stores `changed_paths`, so the migration caution lights up as soon as
 * the server starts including it — absent paths simply mean "no caution".
 */
export type ReceiptWithPaths = PreviewPromotionReceiptSummary & {
  changedPaths?: readonly string[];
};

const DRIZZLE_PATH_PATTERN = /(^|\/)drizzle\//;

/** True when any promoted path is a drizzle migration artifact. */
export function receiptsTouchMigrations(
  receipts: readonly ReceiptWithPaths[],
): boolean {
  return receipts.some((receipt) =>
    (receipt.changedPaths ?? []).some((path) => DRIZZLE_PATH_PATTERN.test(path)),
  );
}

export type PreviewRevertRisk = {
  /** Slept live-mode preview whose latest activity was never captured into a
   * draft PR — waking + reverting could silently drop that work. */
  uncapturedSleep: boolean;
  /** A promotion receipt includes drizzle/ migration paths — reverting the
   * environment will NOT revert applied database migrations. */
  migrationDrift: boolean;
};

export function assessRevertRisk(input: {
  state: VclusterPreviewSummary["state"];
  mode: VclusterPreviewSummary["mode"];
  lastActive: string | null;
  receipts: readonly ReceiptWithPaths[];
}): PreviewRevertRisk {
  const migrationDrift = receiptsTouchMigrations(input.receipts);

  let uncapturedSleep = false;
  if (input.state === "slept" && input.mode !== "reconciled") {
    const newest = input.receipts[0] ?? null;
    if (!newest) {
      uncapturedSleep = true;
    } else if (input.lastActive) {
      const active = Date.parse(input.lastActive);
      const captured = Date.parse(newest.createdAt);
      uncapturedSleep =
        Number.isFinite(active) && Number.isFinite(captured) && active > captured;
    }
  }
  return { uncapturedSleep, migrationDrift };
}

/* ── Deep links ──────────────────────────────────────────────────────── */

export type AgentSessionLinkSource = {
  executionId: string;
  sessionUrl: string | null;
};

export type AgentSessionLink = {
  executionId: string;
  /** Interactive session URL when the group reports one. */
  sessionUrl: string | null;
  /** Always-available dev environment detail route. */
  environmentHref: string;
};

/**
 * Join a preview to its live dev-environment group (agent session) via the
 * non-user owner id or an explicit provenance executionId. Null when no live
 * group matches — the preview has no attachable session right now.
 */
export function agentSessionLink(
  preview: Pick<VclusterPreviewSummary, "owner" | "provenance">,
  groups: readonly AgentSessionLinkSource[],
  slug: string,
): AgentSessionLink | null {
  const candidates = new Set<string>();
  if (preview.owner && preview.owner.kind !== "user" && preview.owner.id) {
    candidates.add(preview.owner.id);
  }
  const provenanceExecution = preview.provenance?.executionId;
  if (typeof provenanceExecution === "string" && provenanceExecution) {
    candidates.add(provenanceExecution);
  }
  for (const group of groups) {
    if (candidates.has(group.executionId)) {
      return {
        executionId: group.executionId,
        sessionUrl: group.sessionUrl,
        environmentHref: `/workspaces/${slug}/dev/${group.executionId}`,
      };
    }
  }
  return null;
}

/** Deep link that reopens the Dev hub with the launch dialog prefilled. */
export function reattachHref(slug: string, previewName: string): string {
  return `/workspaces/${slug}/dev?launch=${encodeURIComponent(previewName)}`;
}

/** The newest promotion receipt (contract order is newest-first). */
export function latestReceipt(
  entry: Pick<PreviewDriftEntry, "receipts"> | null | undefined,
): PreviewPromotionReceiptSummary | null {
  return entry?.receipts[0] ?? null;
}

/** Find one preview's drift entry inside the overview. */
export function driftEntryFor(
  overview: Pick<PreviewDriftOverview, "previews"> | null | undefined,
  previewName: string,
): PreviewDriftEntry | null {
  return overview?.previews.find((entry) => entry.name === previewName) ?? null;
}

/* ── Checkpoint indicator (dev-list per-preview) ─────────────────────── */

/**
 * Compact per-preview code-checkpoint summary for the dev environment list.
 * Derived from the promotion receipts already joined into the drift entry —
 * each receipt is one code version this preview pushed to its pull request, so
 * `promotedCount` is the captured-checkpoint count and `latestCapturedAt` is the
 * age of the most recent capture. Pure; no I/O.
 */
export type PreviewCheckpointIndicator = {
  /** Code checkpoints captured from this preview and pushed to a PR. */
  promotedCount: number;
  /** Newest receipt's pull request number/url, when any checkpoint exists. */
  latestPrNumber: number | null;
  latestPrUrl: string | null;
  /** ISO timestamp of the newest checkpoint push, when any. */
  latestCapturedAt: string | null;
  /** True when at least one checkpoint reached a pull request. */
  promoted: boolean;
};

export function previewCheckpointIndicator(
  entry: Pick<PreviewDriftEntry, "receipts"> | null | undefined,
): PreviewCheckpointIndicator {
  const receipts = entry?.receipts ?? [];
  const latest = receipts[0] ?? null;
  return {
    promotedCount: receipts.length,
    latestPrNumber: latest?.prNumber ?? null,
    latestPrUrl: latest?.prUrl ?? null,
    latestCapturedAt: latest?.createdAt ?? null,
    promoted: receipts.length > 0,
  };
}
