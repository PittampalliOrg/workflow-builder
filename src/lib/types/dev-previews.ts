/**
 * Shared wire types for the Dev hub preview surfaces (Track 1). These cross the
 * server→client boundary (remote-function returns → components), so they carry
 * only serializable data — no methods, no server-only imports. The server-side
 * legacy clients (`$lib/server/workflows/vcluster-preview`) and the application
 * services decorate their records into these shapes.
 */

/** A4/D1 lifecycle state of a Tier-2 preview. */
export type VclusterPreviewState = "hot" | "slept";
export type VclusterPreviewProfile =
  | "app-live"
  | "manifest-candidate"
  | "host-candidate";
export type VclusterPreviewLane = "application" | "management";
export type VclusterPreviewMode = "live" | "reconciled";
export type VclusterPreviewLifecycle = "ephemeral" | "retained";
export type VclusterPreviewOwner = {
  kind: "user" | "workflow" | "session" | "automation";
  id: string;
};
export type VclusterPreviewOrigin = {
  kind:
    | "user"
    | "pull-request"
    | "workflow"
    | "interactive-session"
    | "automation";
  reference?: string;
};
export type VclusterPreviewAllocation = {
  kind: "cold";
};

/**
 * Cluster-level record of one Tier-2 (vcluster full-isolation) preview — the
 * gateway port's return shape (a serializable subset of the legacy client's
 * `VclusterPreview`, i.e. no job/isolation plumbing).
 */
export interface VclusterPreviewRecord {
  name: string;
  /** provisioning | ready | failed | pending | terminating | claiming | slept | absent | unknown */
  phase: string;
  ready: boolean;
  /** Browsable preview URL once ready. */
  url: string | null;
  targetCluster: string;
  /** A3 backing warm-pool member id when CLAIMED (instant), else null. */
  pool: string | null;
  /** A4 lifecycle: "hot" (running) | "slept" (scaled down; a wake resumes it).
   * null against an older SEA that doesn't emit it. */
  state: VclusterPreviewState | null;
  lifecycle: VclusterPreviewLifecycle | null;
  origin: VclusterPreviewOrigin | null;
  legacyOrigin: "user" | "pr" | null;
  prNumber: number | null;
  /** RFC3339 expiry (from ttlHours); the reaper tears the preview down past it. */
  expiresAt: string | null;
  /** RFC3339 last-activity stamp (touch/provision/claim). */
  lastActive: string | null;
  /** Operator hard-exemption: never slept/evicted/reaped. false when absent. */
  protected: boolean;
  /** Seconds the current provision Job has been running (cold-boot progress);
   * null when not booting / unknown. */
  bootSeconds: number | null;
  /** Immutable PreviewEnvironment contract projected from safe namespace annotations. */
  platformRevision: string | null;
  sourceRevision: string | null;
  profile: VclusterPreviewProfile | null;
  lane: VclusterPreviewLane | null;
  mode: VclusterPreviewMode | null;
  owner: VclusterPreviewOwner | null;
  services: string[] | null;
  provenance: Record<string, unknown> | null;
  trustedCode: boolean | null;
  allocation: VclusterPreviewAllocation | null;
  images: Record<string, string> | null;
  catalogDigest: string | null;
}

/**
 * One Tier-2 preview as the Dev hub renders it: a `VclusterPreviewRecord`
 * decorated with the UI-only `prUrl` (built from `prNumber` + the configured
 * repo). Kept distinct from the record so the port stays free of UI concerns.
 */
export interface VclusterPreviewSummary extends VclusterPreviewRecord {
  /** GitHub PR URL for an origin=pr preview; null otherwise. */
  prUrl: string | null;
}

/** Client-safe runtime observation returned after tuple-bound authorization. */
export type VclusterPreviewRuntimeContainerView = {
  image: string;
  ready: boolean;
};

export type VclusterPreviewRuntimeView = {
  name: string;
  reconciliationSucceeded: boolean;
  provision: {
    found: boolean;
    active: boolean;
    succeeded: boolean;
    failed: boolean;
  };
  services: Array<{
    service: string;
    containers: VclusterPreviewRuntimeContainerView[];
  }>;
};

/**
 * A3/A4 capacity accounting from the SEA list. `awake` counts HOT members
 * (claimed + free-hot + regular) and is what gates cold provisions; `baking`
 * counts pool up-Jobs still running (already included in `awake`); a slept
 * preview holds no compute so it never gates. `total`/`totalMax` count
 * everything (awake + slept). Nulls are 0 against an older SEA.
 */
export interface VclusterPreviewCounts {
  awake: number;
  slept: number;
  total: number;
  baking: number;
  free: number;
  claimed: number;
  recycling: number;
  max: number;
  totalMax: number;
  poolSize: number;
}

/**
 * Result of a launch: either the accepted preview, or a capacity refusal
 * returned AS DATA (never thrown) so the UI can render the meter-consistent
 * inline alert instead of a toast.
 */
export type VclusterLaunchResult =
  | { ok: true; preview: VclusterPreviewSummary; pooled: boolean }
  | {
      ok: false;
      reason: "capacity";
      awake: number;
      max: number;
      message: string;
    }
  | {
      ok: false;
      reason: "conflict";
      message: string;
    };

/**
 * Client-safe launch DTO. Identity and trusted provenance are deliberately not
 * present: authenticated server adapters derive both from the session.
 */
export type PreviewEnvironmentLaunchRequest = {
  name: string;
  profile?:
    | "app-live"
    | "manifest-candidate"
    | "host-candidate";
	lane?: "application" | "management";
	pullRequest?: { number: number };
  capabilities?: Array<
    | "service-live-sync"
    | "immutable-image-replay"
    | "namespaced-manifests"
    | "virtual-cluster-control-plane"
    | "host-control-plane"
    | "host-networking"
    | "host-storage"
    | "node-runtime"
    | "gitops-management-plane"
  >;
  platformRevision?: string;
  platformRef?: string;
  sourceRevision?: string;
  sourceRef?: string;
  services?: string[];
  candidatePaths?: string[];
  ttlHours?: number;
  lifecycle?: "ephemeral" | "retained" | "exclusive";
  allocation?: {
    kind: "cold";
  };
  provenance?: { parentEnvironmentId?: string | null };
};

/**
 * Result of a sleep request. A 409 (protected preview, or a free/recycling pool
 * member that stays claim-ready) comes back as a typed refusal, not an error.
 */
export type PreviewSleepResult =
  | { ok: true; name: string; state: "slept"; alreadySlept: boolean }
  | { ok: false; reason: "protected" | "pool-member"; message: string };

/** Result of a wake (touch) request: whether a resume Job was started. */
export interface PreviewWakeResult {
  name: string;
  state: string;
  resuming: boolean;
}

/**
 * One PR-preview record as the Dev hub / gitops lane list it (D1). Derived from
 * the resume-safe `prPreviews.listStatuses()` snapshot + the configured repo
 * (for the PR URL). STRICTLY a read snapshot — listing it never resumes a
 * pipeline.
 */
export interface PrPreviewListItem {
  prNumber: number;
  alias: string;
  url: string | null;
  /** GitHub PR URL (always present — built from prNumber + repo). */
  prUrl: string;
  /** provisioning | seeding | tearing_down | ready | error | capacity_full | absent | unknown */
  state: string;
  headSha: string | null;
  services: string[];
  error: string | null;
  verify: {
    state: "started" | "skipped" | "completed" | "failed";
    reason: string | null;
    verdict: string | null;
  } | null;
  updatedAt: string | null;
}

/**
 * The `lastRun` a dev service's sidecar reports (B5 `/__status` → run history).
 * Parsed from the sidecar's raw `{ name, exitCode, durationMs, executedIn,
 * finishedAt }` into a stable UI shape.
 */
export interface SidecarLastRunView {
  cmd: string;
  exitCode: number | null;
  durationMs: number | null;
  /** #40: where the command ran ("app" bridge = real toolchain, "sidecar" =
   * node-only fallback). null against a sidecar too old to report it. */
  executedIn: "app" | "sidecar" | null;
  finishedAt: string | null;
}

/**
 * Sanitize a user-supplied preview name into a DNS-safe, short id. Pure + shared
 * so the remote command, the application service, and the legacy client all
 * agree on preview identity (the capacity "already this name" check compares
 * against sanitized aliases).
 */
export function safePreviewName(name: string): string {
  return (
    (name || "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "preview"
  );
}
