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

/** Client-safe teardown convergence state projected by the physical controller. */
export type VclusterPreviewCleanupSnapshot = {
  name: string;
  resourceName: string;
  complete: boolean;
  phase: "pending" | "complete" | "failed";
  checks: {
    runnerSucceeded: boolean;
    previewEnvironmentAbsent: boolean;
    applicationAbsent: boolean;
    agentRegistrationAbsent: boolean;
    agentNamespacesAbsent: boolean;
    databaseAbsent: boolean;
    natsStreamAbsent: boolean;
    headlampRegistrationAbsent: boolean;
    tailnetEgressAbsent: boolean;
    hostNamespaceAbsent: boolean;
    storageScopeAbsent: boolean;
    runnerIdentityAbsent: boolean;
  };
  /** Exact durable down-runner identity, when a controller deletion intent exists. */
  teardownProof?: {
    intentId: `sha256:${string}`;
    environmentUid: string;
    requestId: string;
    sourceRevision: string;
    jobName: string;
    jobUid: string;
    runnerGeneration: `op:${string}`;
  };
  message: string | null;
};

/** Exact PreviewEnvironment generation accepted for asynchronous teardown. */
export type VclusterPreviewTeardownTicket = {
  name: string;
  environmentUid: string;
  requestId: string;
  sourceRevision: string;
  /** Physical-broker HMAC; the root never crosses this wire boundary. */
  signature: string;
};

export type VclusterPreviewTeardownAcceptance = {
  preview: VclusterPreviewRecord;
  /** Null only when the guarded target was already absent at submission time. */
  ticket: VclusterPreviewTeardownTicket | null;
};

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

/** Bounded trace controls supported by the preview observability broker. */
export type PreviewTraceRange = "15m" | "1h" | "6h" | "24h";
export type PreviewTraceStatus = "all" | "ok" | "error";

/** Client-safe trace summary. Raw spans and telemetry-store credentials stay physical. */
export type PreviewTraceSummary = {
  traceId: string;
  rootOperation: string;
  rootService: string;
  services: string[];
  startTime: string;
  durationMs: number;
  spanCount: number;
  status: "ok" | "error";
};

export type PreviewTraceQueryView = {
  traces: PreviewTraceSummary[];
  services: string[];
  observedAt: string;
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
  profile?: "app-live" | "manifest-candidate" | "host-candidate";
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
 * Per-service image drift classification for one Tier-2 preview service:
 * - `in-sync`: the running image matches the dev release pin, and the pin is at
 *   workflow-builder main HEAD (or main HEAD is unknown).
 * - `behind-pin`: the running image differs from the current pin but is a KNOWN
 *   historical pin (the preview simply has not rolled forward yet).
 * - `pin-behind-main`: the running image matches the pin, but the pin's source
 *   commit is not workflow-builder main HEAD (a newer build exists upstream).
 * - `diverged`: the running image is neither the current pin nor any known
 *   historical pin (e.g. an agent-built candidate image).
 * - `unknown`: not enough data to classify (slept preview, unreadable runtime,
 *   or no pin exists for the service).
 */
export type PreviewServiceDriftStatus =
  | "in-sync"
  | "behind-pin"
  | "pin-behind-main"
  | "diverged"
  | "unknown";

/**
 * Derived lifecycle stage of a preview for the drift overview. Priority order
 * (first match wins): failed → sleeping → provisioning → agent-editing →
 * promoted → retained → ready.
 */
export type PreviewStage =
  | "provisioning"
  | "agent-editing"
  | "promoted"
  | "retained"
  | "sleeping"
  | "ready"
  | "failed";

/** One promotion receipt, as the drift overview lists it (newest first). */
export type PreviewPromotionReceiptSummary = {
  prNumber: number;
  prUrl: string;
  commitSha: string;
  createdAt: string;
};

/** The observed running image for one preview service (null while slept/unreadable). */
export type PreviewServiceRunningImage = {
  image: string;
  tag: string | null;
  digest: string | null;
  ready: boolean | null;
};

/** The dev release pin for one service (from stacks release-pins on main). */
export type PreviewServicePin = {
  tag: string | null;
  digest: string | null;
  commitSha: string | null;
};

/** One service row of a preview's drift entry. */
export type PreviewServiceDrift = {
  service: string;
  running: PreviewServiceRunningImage | null;
  /** Why `running` is null: "slept" | an observation error message; null when running. */
  runningUnavailableReason: string | null;
  pin: PreviewServicePin | null;
  driftStatus: PreviewServiceDriftStatus;
};

/** One awake/slept preview joined with pins, receipts, and derived stage. */
export type PreviewDriftEntry = {
  name: string;
  phase: string;
  state: VclusterPreviewState | null;
  lifecycle: VclusterPreviewLifecycle | null;
  stage: PreviewStage;
  /** Latest live-sync generation when the platform exposes it; usually null. */
  syncGeneration: string | null;
  services: PreviewServiceDrift[];
  receipts: PreviewPromotionReceiptSummary[];
};

/** Batched drift read for the Dev hub: previews × (runtime, pins, receipts). */
export type PreviewDriftOverview = {
  generatedAt: string;
  repoHeads: {
    workflowBuilderMainSha: string | null;
    stacksMainSha: string | null;
  };
  previews: PreviewDriftEntry[];
};

/**
 * Typed result of the retained-preview commands (release dev lease / freeze
 * sources). `unsupported` = the preview-side endpoint / routing / credential is
 * not available yet (ships with feat/preview-retained-ux); `error` = the
 * endpoint was reached but the operation failed.
 */
export type PreviewRetentionActionResult =
  | { ok: true }
  | { ok: false; reason: "unsupported" | "error"; message: string };

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
