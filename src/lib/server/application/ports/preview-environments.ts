export const PREVIEW_ENVIRONMENT_PROFILES = [
  "app-live",
  "manifest-candidate",
  "host-candidate",
] as const;

export type PreviewEnvironmentProfile =
  (typeof PREVIEW_ENVIRONMENT_PROFILES)[number];

export const PREVIEW_ENVIRONMENT_CAPABILITIES = [
  "service-live-sync",
  "immutable-image-replay",
  "namespaced-manifests",
  "virtual-cluster-control-plane",
  "host-control-plane",
  "host-networking",
  "host-storage",
  "node-runtime",
  "gitops-management-plane",
] as const;

export type PreviewEnvironmentCapability =
  (typeof PREVIEW_ENVIRONMENT_CAPABILITIES)[number];

export const PREVIEW_ENVIRONMENT_MODES = ["reconciled", "live"] as const;
export type PreviewEnvironmentMode = (typeof PREVIEW_ENVIRONMENT_MODES)[number];

export const PREVIEW_ENVIRONMENT_LIFECYCLES = [
  "ephemeral",
  "retained",
  "exclusive",
] as const;
export type PreviewEnvironmentLifecycle =
  (typeof PREVIEW_ENVIRONMENT_LIFECYCLES)[number];

export const PREVIEW_ENVIRONMENT_ORIGINS = [
  "user",
  "pull-request",
  "workflow",
  "interactive-session",
  "automation",
] as const;
export type PreviewEnvironmentOriginKind =
  (typeof PREVIEW_ENVIRONMENT_ORIGINS)[number];

export const PREVIEW_ENVIRONMENT_OWNER_KINDS = [
  "user",
  "workflow",
  "session",
  "automation",
] as const;
export type PreviewEnvironmentOwnerKind =
  (typeof PREVIEW_ENVIRONMENT_OWNER_KINDS)[number];

export type PreviewEnvironmentPlacement = "dev-vcluster" | "dev-physical";
export type PreviewEnvironmentLane = "application" | "management";

declare const immutableGitShaBrand: unique symbol;
/** A complete 40-hex Git object id. Branches and abbreviated SHAs are excluded. */
export type ImmutableGitSha = string & {
  readonly [immutableGitShaBrand]: true;
};

export type PreviewEnvironmentOwner = Readonly<{
  kind: PreviewEnvironmentOwnerKind;
  id: string;
}>;

export type PreviewEnvironmentOrigin = Readonly<{
  kind: PreviewEnvironmentOriginKind;
  reference?: string | null;
}>;

export type PreviewEnvironmentProvenance = Readonly<{
  requestId: string;
  requestedAt: string;
  platformRepository: string;
  sourceRepository: string;
  parentEnvironmentId?: string | null;
}>;

export type PreviewEnvironmentAllocationInput = Readonly<{ kind: "cold" }>;
export type PreviewEnvironmentAllocation = Readonly<{ kind: "cold" }>;

/** Production image overrides used only by clean reconciled acceptance runs. */
export type PreviewEnvironmentImageOverrides = Readonly<Record<string, string>>;

/** Untrusted application input. The application service validates and brands it. */
export type PreviewEnvironmentLaunchSpec = Readonly<{
  name: string;
  profile: PreviewEnvironmentProfile;
  /** Management is an operator-only lane within manifest-candidate. */
  lane?: PreviewEnvironmentLane;
  capabilities: readonly PreviewEnvironmentCapability[];
  platformRevision: string;
  sourceRevision: string;
  services: readonly string[];
  candidatePaths?: readonly string[];
  owner: PreviewEnvironmentOwner;
  origin: PreviewEnvironmentOrigin;
  ttlHours: number;
  mode: PreviewEnvironmentMode;
  imageOverrides?: Readonly<Record<string, string>>;
  lifecycle: PreviewEnvironmentLifecycle;
  allocation: PreviewEnvironmentAllocationInput;
  provenance: PreviewEnvironmentProvenance;
}>;

/** Adapter command produced only after all domain invariants have passed. */
export type ValidatedPreviewEnvironmentLaunchSpec = Readonly<{
  name: string;
  profile: PreviewEnvironmentProfile;
  lane: PreviewEnvironmentLane;
  capabilities: readonly PreviewEnvironmentCapability[];
  placement: PreviewEnvironmentPlacement;
  platformRevision: ImmutableGitSha;
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  services: readonly string[];
  candidatePaths: readonly string[];
  owner: PreviewEnvironmentOwner;
  origin: PreviewEnvironmentOrigin;
  ttlHours: number;
  mode: PreviewEnvironmentMode;
  imageOverrides: PreviewEnvironmentImageOverrides;
  lifecycle: PreviewEnvironmentLifecycle;
  allocation: PreviewEnvironmentAllocation;
  provenance: PreviewEnvironmentProvenance;
}>;

export type PreviewEnvironmentLifecycleState =
  | "requested"
  | "provisioning"
  | "ready"
  | "sleeping"
  | "slept"
  | "recycling"
  | "terminating"
  | "terminated"
  | "failed";

export type PreviewEnvironment = ValidatedPreviewEnvironmentLaunchSpec &
  Readonly<{
    id: string;
    lifecycleState: PreviewEnvironmentLifecycleState;
    createdAt: string;
    expiresAt: string;
    runtime: Readonly<{
      placement: PreviewEnvironmentPlacement;
      phase: string;
      ready: boolean;
      url: string | null;
      allocationId: string | null;
      pooled: boolean;
    }>;
  }>;

export type PreviewEnvironmentLaunchOutcome =
  | Readonly<{ ok: true; environment: PreviewEnvironment }>
  | Readonly<{
      ok: false;
      reason: "capacity";
      awake: number;
      max: number;
      message: string;
    }>
  | Readonly<{
      ok: false;
      reason: "conflict";
      message: string;
    }>;

export type PreviewEnvironmentUserLaunchInput = Readonly<{
  name: string;
  userId: string;
  profile?: PreviewEnvironmentProfile;
  lane?: PreviewEnvironmentLane;
  capabilities?: readonly PreviewEnvironmentCapability[];
  platformRevision?: string | null;
  platformRef?: string | null;
  sourceRevision?: string | null;
  sourceRef?: string | null;
  services?: readonly string[];
  candidatePaths?: readonly string[];
  ttlHours?: number;
  lifecycle?: PreviewEnvironmentLifecycle;
  allocation?: Readonly<{ kind: "cold" }>;
  provenance?: Readonly<{ parentEnvironmentId?: string | null }>;
}>;

/** Inbound launch use case, implemented locally or through the physical broker. */
export interface PreviewEnvironmentUserLaunchPort {
  previewNativeServices(): readonly string[];
  launchForUser(
    input: PreviewEnvironmentUserLaunchInput,
  ): Promise<PreviewEnvironmentLaunchOutcome>;
}

export interface PreviewEnvironmentRevisionResolverPort {
  resolve(
    input: Readonly<{ repository: string; ref: string }>,
  ): Promise<string>;
}

/** Outbound launch port. Infrastructure-specific behavior belongs in adapters. */
export interface PreviewEnvironmentLaunchPort {
  launch(
    input: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentLaunchOutcome>;
}

export type PreviewEnvironmentDesiredStateSnapshot = Readonly<{
  name: string;
  uid: string;
  generation: number;
  phase:
    | "Pending"
    | "Failed"
    | "Blocked"
    | "Provisioning"
    | "Ready"
    | "Expired"
    | "Terminating";
  ready: boolean;
}>;

export type PreviewEnvironmentDesiredStateDeleteGuard =
  | Readonly<{
      mode: "owned";
      requestId: string;
      sourceRevision: string;
    }>
  | Readonly<{
      mode: "superseded";
      protectedRequestId: string;
    }>;

export const PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS = [
  "runnerSucceeded",
  "databaseAbsent",
  "natsStreamAbsent",
  "tailnetEgressAbsent",
  "hostNamespaceAbsent",
  "storageScopeAbsent",
  "runnerIdentityAbsent",
] as const;

export type PreviewEnvironmentPhysicalCleanupCheck =
  (typeof PREVIEW_ENVIRONMENT_PHYSICAL_CLEANUP_CHECKS)[number];

/** Durable command authored by the hub controller and consumed only on dev. */
export type PreviewEnvironmentDeletionIntent = Readonly<{
  id: `sha256:${string}`;
  name: string;
  environmentUid: string;
  requestId: string;
  platformRevision: ImmutableGitSha;
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  deletionTimestamp: string;
}>;

/** Exact SEA receipt persisted back to the hub CR before finalizer release. */
export type PreviewEnvironmentDeletionAcknowledgement = Readonly<{
  intentId: `sha256:${string}`;
  environmentUid: string;
  requestId: string;
  platformRevision: ImmutableGitSha;
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  observedAt: string;
  resourceName: string;
  runner: Readonly<{
    jobName: string;
    jobUid: string;
    generation: `op:${string}`;
  }>;
  checks: Readonly<Record<PreviewEnvironmentPhysicalCleanupCheck, true>>;
}>;

/** Operational failures exposed by the desired-state port to application callers. */
export class PreviewEnvironmentDesiredStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PreviewEnvironmentDesiredStateError";
  }
}

export class PreviewEnvironmentDesiredStateConflictError extends PreviewEnvironmentDesiredStateError {
  constructor(name: string, options?: ErrorOptions) {
    super(
      `PreviewEnvironment ${name} already exists with a different contract`,
      options,
    );
    this.name = "PreviewEnvironmentDesiredStateConflictError";
  }
}

export class PreviewEnvironmentDesiredStateOwnershipError extends PreviewEnvironmentDesiredStateError {
  constructor(message: string) {
    super(message);
    this.name = "PreviewEnvironmentDesiredStateOwnershipError";
  }
}

/** Durable result of submitting the UID-fenced PreviewEnvironment deletion. */
export type PreviewEnvironmentDeletionRequestReceipt = Readonly<{
  name: string;
}> &
  (
    | Readonly<{
        environmentUid: string;
        state: "deletion-requested";
      }>
    | Readonly<{
        environmentUid: null;
        state: "absent";
      }>
  );

/**
 * Physical desired-state authority for the hub PreviewEnvironment CR.
 *
 * The vCluster runner is deliberately outside this port: it never receives a
 * hub credential and cannot mutate another preview's desired state.
 */
export interface PreviewEnvironmentDesiredStatePort {
  create(
    input: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentDesiredStateSnapshot>;
  inspect(
    input: ValidatedPreviewEnvironmentLaunchSpec,
  ): Promise<PreviewEnvironmentDesiredStateSnapshot | null>;
  requestDelete(
    input: Readonly<{
      name: string;
      guard: PreviewEnvironmentDesiredStateDeleteGuard;
    }>,
  ): Promise<PreviewEnvironmentDeletionRequestReceipt>;
  observeDelete(input: Readonly<{
    name: string;
    environmentUid: string;
    guard: Extract<PreviewEnvironmentDesiredStateDeleteGuard, { mode: "owned" }>;
  }>): Promise<"pending" | "complete">;
  deleteAndWait(
    input: Readonly<{
      name: string;
      guard: PreviewEnvironmentDesiredStateDeleteGuard;
      timeoutMs: number;
    }>,
  ): Promise<void>;
  absent(name: string): Promise<boolean>;
}

/** Dev-side consumer port for the hub CR deletion-intent outbox. */
export interface PreviewEnvironmentDeletionOutboxPort {
  listPending(): Promise<readonly PreviewEnvironmentDeletionIntent[]>;
  acknowledge(
    intent: PreviewEnvironmentDeletionIntent,
    acknowledgement: PreviewEnvironmentDeletionAcknowledgement,
  ): Promise<void>;
  absent(name: string): Promise<boolean>;
}

export type PreviewEnvironmentCleanupReceipt = Readonly<{
  name: string;
  jobName: string;
  jobUid: string;
  runnerGeneration: `op:${string}`;
}>;

/** SEA-owned durable receipt inventory; release is allowed only after hub CR absence. */
export interface PreviewEnvironmentCleanupReceiptPort {
  list(): Promise<readonly PreviewEnvironmentCleanupReceipt[]>;
  release(receipt: PreviewEnvironmentCleanupReceipt): Promise<void>;
}

export type PreviewProductionImage = Readonly<{
  service: string;
  sourceRevision: ImmutableGitSha;
  buildId: string;
  imageRef: string;
  digest: `sha256:${string}`;
  immutableRef: string;
}>;

/** Selective production builds for a clean acceptance replay. */
export interface PreviewEnvironmentImageBuildPort {
  build(
    input: Readonly<{
      requestId: string;
      sourceRepository: string;
      sourceRevision: ImmutableGitSha;
      services: readonly string[];
    }>,
  ): Promise<readonly PreviewProductionImage[]>;
}

/** Catalog admission stays above build and cluster adapters. */
export interface PreviewEnvironmentServiceCatalogPort {
  listPreviewNativeServices(): readonly string[];
  assertPreviewNativeServices(services: readonly string[]): readonly string[];
}

/** Catalog reads which also need to bind an operation to an exact catalog. */
export interface PreviewEnvironmentVersionedServiceCatalogPort extends PreviewEnvironmentServiceCatalogPort {
  currentDigest(): `sha256:${string}`;
}

/** Catalog admission for clean immutable replay, independent of hot-sync support. */
export interface PreviewEnvironmentAcceptanceCatalogPort extends PreviewEnvironmentVersionedServiceCatalogPort {
  assertAcceptanceReplayServices(
    services: readonly string[],
  ): readonly string[];
}

export interface PreviewEnvironmentCandidatePathPolicyPort {
  assertManifestCandidatePaths(paths: readonly string[]): readonly string[];
}

export type PreviewEnvironmentCandidatePathRoute = Readonly<{
  profile: "manifest-candidate" | "host-candidate";
  lane: PreviewEnvironmentLane;
  paths: readonly string[];
}>;

/** Stacks-owned routing contract for GitHub-verified infrastructure changes. */
export interface PreviewEnvironmentCandidatePathRoutingPort {
  routeCandidatePaths(
    paths: readonly string[],
  ): PreviewEnvironmentCandidatePathRoute;
}

export interface PreviewEnvironmentReadinessPort {
  waitReady(
    input: Readonly<{
      name: string;
      platformRevision: ImmutableGitSha;
      sourceRevision: ImmutableGitSha;
      profile: PreviewEnvironmentProfile;
      lane: PreviewEnvironmentLane;
      mode: PreviewEnvironmentMode;
      services: readonly string[];
      owner: PreviewEnvironmentOwner;
      origin: PreviewEnvironmentOrigin;
      lifecycle: PreviewEnvironmentLifecycle;
      allocation: PreviewEnvironmentAllocation;
      provenance: PreviewEnvironmentProvenance;
      images: PreviewEnvironmentImageOverrides;
      catalogDigest: `sha256:${string}`;
      timeoutMs: number;
    }>,
  ): Promise<Readonly<{ ready: boolean; phase: string; url: string | null }>>;
}

export type PreviewEnvironmentInventoryRecord = Readonly<{
  exists: boolean;
  phase: string;
}>;

/** Fail-closed existence lookup used before a clean acceptance build starts. */
export interface PreviewEnvironmentInventoryPort {
  inspect(name: string): Promise<PreviewEnvironmentInventoryRecord>;
}

export type PreviewEnvironmentRuntimeContainer = Readonly<{
  pod: string;
  image: string;
  imageId: string | null;
  ready: boolean;
}>;

export type PreviewEnvironmentRuntimeService = Readonly<{
  service: string;
  containers: readonly PreviewEnvironmentRuntimeContainer[];
}>;

export type PreviewEnvironmentRuntimeSnapshot = Readonly<{
  name: string;
  resourceName: string;
  reconciliationSucceeded: boolean;
  services: readonly PreviewEnvironmentRuntimeService[];
}>;

export type PreviewEnvironmentRuntimeVerification = Readonly<{
  ok: boolean;
  checks: readonly Readonly<{
    service: string;
    ok: boolean;
    expectedImage: string;
    observedImages: readonly string[];
    detail?: string;
  }>[];
}>;

/** Observe the real Ready pod container images through the cluster adapter. */
export interface PreviewEnvironmentRuntimeInspectionPort {
  waitForImages(
    input: Readonly<{
      name: string;
      images: PreviewEnvironmentImageOverrides;
      timeoutMs: number;
    }>,
  ): Promise<PreviewEnvironmentRuntimeVerification>;
}

export type PreviewEnvironmentCleanupCheck =
  | "runner-succeeded"
  | "preview-environment-absent"
  | "application-absent"
  | "agent-registration-absent"
  | "agent-namespaces-absent"
  | "database-absent"
  | "nats-stream-absent"
  | "headlamp-registration-absent"
  | "tailnet-egress-absent"
  | "host-namespace-absent"
  | "storage-scope-absent"
  | "runner-identity-absent";

export type PreviewEnvironmentCleanupProof = Readonly<{
  name: string;
  resourceName: string;
  complete: boolean;
  phase: "pending" | "complete" | "failed" | "timeout";
  checks: Readonly<Record<PreviewEnvironmentCleanupCheck, boolean>>;
  message: string | null;
}>;

export type PreviewEnvironmentVerificationResult = Readonly<{
  ok: boolean;
  checks: readonly Readonly<{
    name: string;
    ok: boolean;
    detail?: string;
  }>[];
}>;

export interface PreviewEnvironmentVerificationPort {
  verify(
    input: Readonly<{
      environment: PreviewEnvironment;
      images: readonly PreviewProductionImage[];
    }>,
  ): Promise<PreviewEnvironmentVerificationResult>;
}

export interface PreviewEnvironmentTeardownPort {
  teardown(
    input: Readonly<{
      name: string;
      timeoutMs: number;
      guard:
        | Readonly<{
            mode: "owned";
            requestId: string;
            sourceRevision: ImmutableGitSha;
          }>
        | Readonly<{
            mode: "superseded";
            protectedRequestId: string;
          }>;
    }>,
  ): Promise<PreviewEnvironmentCleanupProof>;
}
