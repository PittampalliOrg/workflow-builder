// Ports for the Dev hub preview surfaces (Track 1): the Tier-2 vcluster preview
// gateway and the per-service dev-sync-sidecar. These wrap the privileged
// legacy clients (`$lib/server/workflows/{vcluster-preview,dev-preview-sidecar}`)
// so the four dev routes stop importing legacy domain modules directly.

import type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewCounts,
  VclusterPreviewRecord,
  VclusterPreviewTeardownAcceptance,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";
export type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewTeardownAcceptance,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";
import type {
  PreviewEnvironmentDeletionIntent,
  PreviewEnvironmentLifecycle,
  PreviewEnvironmentLane,
  PreviewEnvironmentOrigin,
  PreviewEnvironmentOwner,
  PreviewEnvironmentProfile,
  PreviewEnvironmentProvenance,
} from "./preview-environments";
import type { PreviewCapabilityBundle } from "./preview-control";
import type { PreviewControlIdentity } from "./preview-control";

/** A4 activity/wake outcome: whether a resume Job was started for a slept preview. */
export type VclusterPreviewTouchResult = {
  name: string;
  state: string;
  resuming: boolean;
  lastActive: string | null;
};

/** A4 sleep outcome at the gateway boundary. A 409 (protected preview, or a
 * free/recycling pool member that stays claim-ready) is data — `{ok:false,
 * status:409}` — not an exception; other HTTP failures still throw. */
export type VclusterPreviewSleepOutcome =
  | { ok: true; name: string; alreadySlept: boolean }
  | { ok: false; status: number; detail: string };

export type PreviewArchiveQuarantineGuard = Readonly<{
  forcedAt: string;
  graceExpiredAt: string;
  reason: string;
  summaryFileId?: string;
}>;

/** Lifecycle labels accepted by claim/provision (all optional). */
export type VclusterPreviewLifecycleInput = {
  lifecycle?: PreviewEnvironmentLifecycle;
  origin?: PreviewEnvironmentOrigin;
  prNumber?: number;
  ttlHours?: number;
};

/** Immutable profiled-launch fields forwarded to the privileged SEA adapter. */
export type VclusterPreviewProfileInput = {
  platformRevision?: string;
  sourceRevision?: string;
  catalogDigest?: `sha256:${string}`;
  candidatePaths?: readonly string[];
  delivery?: "imperative" | "reconciler";
  enrollMode?: "imperative" | "agent";
  profile?: PreviewEnvironmentProfile;
  lane?: PreviewEnvironmentLane;
  mode?: "live" | "reconciled";
  allocation?: Readonly<{ kind: "cold" }>;
  imageOverrides?: Readonly<Record<string, string>>;
  owner?: PreviewEnvironmentOwner;
  services?: readonly string[];
  provenance?: PreviewEnvironmentProvenance;
  trustedCode?: boolean;
  /** Reject adoption/replacement; used by clean reconciled acceptance launches. */
  createOnly?: boolean;
  /** Broker-derived tuple capabilities. The HMAC root never crosses this port. */
  capabilityBundle?: PreviewCapabilityBundle;
};

export type VclusterPreviewLaunchInput = VclusterPreviewLifecycleInput &
  VclusterPreviewProfileInput;

export type VclusterPreviewRuntimeContainer = {
  pod: string;
  image: string;
  imageId: string | null;
  ready: boolean;
};

/** Privileged adapter observation. Presentation services must normalize it. */
export type VclusterPreviewRuntimeSnapshot = {
  name: string;
  resourceName: string;
  reconciliationSucceeded: boolean;
  upJob: {
    name: string;
    found: boolean;
    active: boolean;
    succeeded: boolean;
    failed: boolean;
  };
  services: Array<{
    service: string;
    containers: VclusterPreviewRuntimeContainer[];
  }>;
};

export type TupleBoundVclusterPreviewRuntimeSnapshot =
  VclusterPreviewRuntimeSnapshot &
    Readonly<{ identity: PreviewControlIdentity }>;

/** Stable application error for a replaced or mismatched preview generation. */
export class PreviewRuntimeIdentityChangedError extends Error {
  constructor(message = "preview identity changed during runtime observation") {
    super(message);
    this.name = "PreviewRuntimeIdentityChangedError";
  }
}

/**
 * Bounded Tier-2 (vcluster full-isolation) preview gateway. Mirrors the
 * legacy client verbs, but returns the serializable `VclusterPreviewRecord`
 * (not the legacy shape) and turns the sleep 409 into data. The capacity-
 * admission policy lives ABOVE this port, in `ApplicationVclusterPreviewService`.
 */
export interface VclusterPreviewGatewayPort {
  /** List active previews + A3/A4 capacity counts (null against an older SEA). */
  listWithCounts(): Promise<{
    previews: VclusterPreviewRecord[];
    counts: VclusterPreviewCounts | null;
  }>;
  /** Current status of one preview (accepts a claimed alias). */
  get(name: string): Promise<VclusterPreviewRecord>;
  /** Cold-provision (ACTION=up). Capacity gating is the service's job. */
  provision(
    input: { name: string } & VclusterPreviewLaunchInput,
  ): Promise<VclusterPreviewRecord>;
  /** Tear down (drops the per-preview DB + `vcluster delete`). */
  teardown(
    name: string,
    guard:
      | Readonly<{
          mode: "owned";
          requestId: string;
          sourceRevision: string;
          /**
           * Host-only archive token authorization after a complete archive or
           * an explicit bounded forced-quarantine decision.
           */
          archiveConfirmed?: true;
          /** Durable post-grace loss-accounting marker for bounded forced teardown. */
          archiveQuarantine?: PreviewArchiveQuarantineGuard;
          /** Broker-only identity that binds the SEA receipt to one deleting CR UID. */
          deletionIntent?: PreviewEnvironmentDeletionIntent;
        }>
      | Readonly<{ mode: "superseded"; protectedRequestId: string }>,
  ): Promise<VclusterPreviewRecord>;
  /** Actual Ready pod image observations from the host Kubernetes API. */
  runtime(name: string): Promise<VclusterPreviewRuntimeSnapshot>;
  /** Same observation, fenced to one immutable PreviewEnvironment generation. */
  runtimeForIdentity(
    identity: PreviewControlIdentity,
  ): Promise<TupleBoundVclusterPreviewRuntimeSnapshot>;
  /** Down-runner convergence proof. Runner success asserts every hub cleanup check. */
  cleanup(name: string): Promise<VclusterPreviewCleanupSnapshot>;
  /** A4 activity ping + wake: stamps last-active, resumes a slept preview. */
  touch(name: string): Promise<VclusterPreviewTouchResult>;
  /** A4 explicit sleep; refusal (409) returned as data. */
  sleep(name: string): Promise<VclusterPreviewSleepOutcome>;
}

/**
 * Fast user-command boundary for preview teardown.
 *
 * Background lifecycle and acceptance callers keep using
 * `VclusterPreviewGatewayPort.teardown`, whose contract is full convergence.
 */
export interface PreviewEnvironmentTeardownCommandPort {
  request(
    name: string,
    guard: Extract<
      NonNullable<Parameters<VclusterPreviewGatewayPort["teardown"]>[1]>,
      { mode: "owned" }
    >,
  ): Promise<VclusterPreviewTeardownAcceptance>;
}

/** Generation-fenced query boundary for accepted asynchronous teardown. */
export interface PreviewEnvironmentTeardownStatusPort {
  status(
    ticket: VclusterPreviewTeardownTicket,
  ): Promise<VclusterPreviewCleanupSnapshot>;
}

/** Raw dev-sync-sidecar `/__status` body (before the service parses `lastRun`). */
export type DevPreviewSyncTimings = {
  validation: number;
  staging: number;
  planning: number;
  commit: number;
  total: number;
};

export type DevPreviewSidecarStatus = {
  ok: boolean;
  service?: string;
  dest?: string;
  lastSyncAt?: string | null;
  lastSyncBytes?: number | null;
  lastSyncTimingsMs?: DevPreviewSyncTimings | null;
  lastRun?: unknown;
  commands?: string[];
};

export type DevPreviewSidecarRunOutput = {
  ok: boolean;
  cmd: string;
  exitCode: number | null;
  durationMs: number | null;
  truncated: boolean;
  output: string;
  /** #40: where the command ran ("app" bridge vs "sidecar" node fallback). */
  executedIn: "app" | "sidecar" | null;
};

export type DevPreviewSidecarSyncOutput = {
  ok: boolean;
  status: number;
  bytes: number;
  body: unknown;
};

/** Sidecar reachability outcome: unreachable/plugin-mode pods are data, not throws. */
export type DevPreviewSidecarResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "no-sidecar" | "unreachable" | "bad-response" | "forbidden";
      message?: string;
    };

/** Per-service dev pod control channel (B5). Wraps the pod-IP `/__status` /
 * `/__run` calls the BFF makes with an exact receiver leaf. */
export interface DevPreviewSidecarPort {
  status(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarStatus>>;
  run(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
    cmd: string;
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarRunOutput>>;
  sync(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
    archive: ArrayBuffer | Uint8Array;
    contentType?: string | null;
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarSyncOutput>>;
  /** Registry-declared allowlisted command names for a service (deny = []). */
  allowedCommands(service: string): string[];
}
