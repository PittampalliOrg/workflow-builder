import type {
  ImmutableGitSha,
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentLaunchOutcome,
  PreviewEnvironmentMode,
  PreviewEnvironmentProfile,
  PreviewEnvironmentProvenance,
  PreviewEnvironmentServiceCatalogPort,
  PreviewEnvironmentVerificationResult,
  PreviewProductionImage,
} from "./preview-environments";
import type { PreviewDevelopmentImage } from "./preview-development-build";
import type { PreviewImportedArtifactIdentity } from "./preview-acceptance-trust";

/** Immutable preview identity carried across every control-plane boundary. */
export type PreviewControlIdentity = Readonly<{
  previewName: string;
  environmentRequestId: string;
  environmentPlatformRevision: string;
  environmentSourceRevision: string;
  catalogDigest: `sha256:${string}`;
}>;

/** Purpose-separated leaf capabilities minted for one immutable identity. */
export type PreviewCapabilityBundle = Readonly<{
  controlToken: string;
  syncToken: string;
  actionToken: string;
  sandboxToken: string;
  runtimeToken: string;
  storageToken: string;
}>;

/** Local immutable tuple, read through an environment adapter at the edge. */
export interface PreviewLocalControlIdentityPort {
  current(expectedName?: string): PreviewControlIdentity;
}

export type PreviewControlEnvironmentRecord = Readonly<{
  name: string;
  exists: boolean;
  ready: boolean;
  owner: string | null;
  profile: PreviewEnvironmentProfile | null;
  mode: PreviewEnvironmentMode | null;
  trustedCode: boolean;
  platformRevision: string | null;
  sourceRevision: string | null;
  catalogDigest: string | null;
  services: readonly string[];
  provenance: PreviewEnvironmentProvenance | null;
}>;

export interface PreviewControlEnvironmentInspectionPort {
  inspect(name: string): Promise<PreviewControlEnvironmentRecord>;
}

export interface PreviewControlAdminAuthorizationPort {
  isPlatformAdmin(userId: string): Promise<boolean>;
}

export interface PreviewControlGitSourceVerificationPort {
  verifyBranch(
    input: Readonly<{
      repository: string;
      branch: string;
      commitSha: ImmutableGitSha;
      baseBranch: string;
      baseRevision: ImmutableGitSha;
      /** When present, prove the PR base snapshot is on the live base ancestry chain. */
      expectedBaseSnapshot?: ImmutableGitSha;
      /** When present, GitHub's complete immutable commit diff must match exactly. */
      expectedChangedPaths?: readonly string[];
    }>,
  ): Promise<boolean>;
}

export type PreviewControlSourceAuthorityInput = Readonly<{
  previewName: string;
  environmentRequestId: string;
  environmentPlatformRevision: string;
  environmentSourceRevision: string;
  catalogDigest: `sha256:${string}`;
  requiredServices: readonly string[];
}>;

export type AuthorizedPreviewControlSource = Readonly<{
  previewName: string;
  requestId: string;
  owner: string;
  platformRevision: ImmutableGitSha;
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  services: readonly string[];
}>;

/** Reusable physical-control-plane authorization for source-backed operations. */
export interface PreviewControlSourceAuthorityPort {
  authorize(
    input: PreviewControlSourceAuthorityInput,
  ): Promise<AuthorizedPreviewControlSource>;
  authorizeRuntime(
    input: PreviewControlSourceAuthorityInput,
  ): Promise<AuthorizedPreviewControlSource>;
  authorizeRuntimeTuple(
    input: PreviewControlIdentity,
  ): Promise<AuthorizedPreviewControlSource>;
  authorizeCurrent(
    input: Readonly<{
      previewName: string;
      requiredServices: readonly string[];
    }>,
  ): Promise<AuthorizedPreviewControlSource>;
}

export type PreviewDevSyncCredentialRequest = PreviewControlIdentity &
  Readonly<{
    executionId: string;
    service: string;
  }>;

export type PreviewDevSyncCredentialPair = Readonly<{
  receiverToken: string;
  agentActionToken: string;
}>;

/** Physical mint for purpose-separated leaves; no derivation root crosses this port. */
export interface PreviewDevSyncCredentialMintPort {
  mint(
    input: PreviewDevSyncCredentialRequest,
  ): Promise<PreviewDevSyncCredentialPair>;
}

/** Cryptographic adapter owned by the physical broker deployment. */
export interface PreviewDevSyncLeafIssuerPort {
  issue(input: PreviewDevSyncCredentialRequest): PreviewDevSyncCredentialPair;
}

/** Mutable-preview adapter to the authenticated physical credential mint. */
export interface PreviewDevSyncCredentialBrokerPort {
  mint(
    input: PreviewDevSyncCredentialRequest,
  ): Promise<PreviewDevSyncCredentialPair>;
}

export type PreviewControlPullRequest = Readonly<{
  repository: string;
  number: number;
  draft: boolean;
  baseSha: ImmutableGitSha;
  headRef: string;
  headSha: ImmutableGitSha;
  changedPaths: readonly string[];
}>;

export interface PreviewControlPullRequestInspectionPort {
  inspectOpen(
    input: Readonly<{
      repository: string;
      number: number;
    }>,
  ): Promise<PreviewControlPullRequest>;
  inspect(
    input: Readonly<{
      repository: string;
      number: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
    }>,
  ): Promise<PreviewControlPullRequest>;
}

/** Short-lived physical-broker credential; the GitHub App private key stays behind this port. */
export interface PreviewGitHubInstallationTokenPort {
  token(): Promise<string>;
}

export type PreviewInfrastructureCandidateBrokerRequest = Readonly<{
  requestId: string;
  name: string;
  userId: string;
  pullRequestNumber: number;
  ttlHours?: number;
  lifecycle?: "ephemeral" | "retained";
}>;

export type PreviewInfrastructureCandidateBrokerResult =
  | Readonly<{
      ok: boolean;
      status: "launched";
      profile: "manifest-candidate";
      lane: "application";
      pullRequest: PreviewControlPullRequest;
      changedPaths: readonly string[];
      launch: PreviewEnvironmentLaunchOutcome;
    }>
  | Readonly<{
      ok: false;
      status: "operator-required";
      profile: "manifest-candidate" | "host-candidate";
      lane: "management" | "application";
      pullRequest: PreviewControlPullRequest;
      changedPaths: readonly string[];
      launch: null;
      operatorAction: Readonly<{
        command:
          | "preview-management-candidate.sh"
          | "preview-host-candidate.sh";
        id: string;
        revision: ImmutableGitSha;
        candidatePaths: readonly string[];
      }>;
    }>;

export interface PreviewInfrastructureCandidateLaunchPort {
  launch(
    input: Readonly<{
      name: string;
      userId: string;
      profile: "manifest-candidate" | "host-candidate";
      lane: "application" | "management";
      platformRevision: ImmutableGitSha;
      sourceRef: string;
      capabilities: readonly (
        | "namespaced-manifests"
        | "gitops-management-plane"
        | "host-control-plane"
      )[];
      candidatePaths: readonly string[];
      ttlHours: number;
      lifecycle: "ephemeral" | "retained" | "exclusive";
      parentEnvironmentId: string;
    }>,
  ): Promise<PreviewEnvironmentLaunchOutcome>;
}

export interface PreviewInfrastructureCandidateBrokerPort {
  launch(
    input: PreviewInfrastructureCandidateBrokerRequest,
  ): Promise<PreviewInfrastructureCandidateBrokerResult>;
}

export type PreviewAcceptanceChangedServices = Readonly<{
  services: readonly string[];
  activationArtifacts: readonly string[];
  unmappedRuntimePaths: readonly string[];
}>;

export interface PreviewAcceptanceChangedServiceCatalogPort {
  currentDigest(): `sha256:${string}`;
  deriveChangedServices(
    paths: readonly string[],
  ): PreviewAcceptanceChangedServices;
}

export type PreviewDevelopmentBrokerServiceResult =
  | Readonly<{
      service: string;
      ok: true;
      image: PreviewDevelopmentImage;
    }>
  | Readonly<{ service: string; ok: false; error: string }>;

export type PreviewDevelopmentBrokerRequest = Readonly<{
  requestId: string;
  executionId: string;
  artifactId: string;
  previewName: string;
  catalogDigest: `sha256:${string}`;
  services: readonly string[];
  artifactIdentity?: PreviewImportedArtifactIdentity;
  environmentRequestId?: string;
  environmentPlatformRevision?: string;
  environmentSourceRevision?: string;
}>;

export type PreviewScopedDevelopmentBrokerRequest =
  PreviewDevelopmentBrokerRequest &
    Readonly<{
      environmentRequestId: string;
      environmentPlatformRevision: string;
      environmentSourceRevision: string;
      artifactIdentity: PreviewImportedArtifactIdentity;
    }>;

export type PreviewDevelopmentBrokerResult = Readonly<{
  ok: boolean;
  previewName: string;
  branch: string;
  sourceRevision: ImmutableGitSha;
  baselineRevision: ImmutableGitSha;
  pullRequestBase: string;
  changedPaths: readonly string[];
  catalogDigest: `sha256:${string}`;
  services: readonly PreviewDevelopmentBrokerServiceResult[];
}>;

/** Narrow client boundary from a mutable preview BFF to the physical broker. */
export interface PreviewDevelopmentBuildBrokerPort {
  build(
    input: PreviewDevelopmentBrokerRequest,
  ): Promise<PreviewDevelopmentBrokerResult>;
}

export type PreviewAcceptanceBrokerRequest = Readonly<{
  requestId: string;
  previewName: string;
  pullRequest: Readonly<{
    repository: string;
    number: number;
    baseSha: ImmutableGitSha;
    headSha: ImmutableGitSha;
  }>;
  environmentRequestId?: string;
  environmentPlatformRevision?: string;
  environmentSourceRevision?: string;
  catalogDigest?: `sha256:${string}`;
}>;

/** Catalog proof needed by an untrusted HTTP acceptance-result adapter. */
export interface PreviewAcceptanceResponseCatalogPort extends PreviewEnvironmentServiceCatalogPort {
  assertAcceptanceReplayServices(
    services: readonly string[],
  ): readonly string[];
  acceptanceImageRepository(service: string): string;
}

export type PreviewScopedAcceptanceBrokerRequest =
  PreviewAcceptanceBrokerRequest &
    Readonly<{
      environmentRequestId: string;
      environmentPlatformRevision: string;
      environmentSourceRevision: string;
      catalogDigest: `sha256:${string}`;
    }>;

export type PreviewAcceptanceBrokerResult = Readonly<{
  ok: boolean;
  name: string;
  previewName: string;
  pullRequest: Readonly<{
    repository: string;
    number: number;
    baseSha: ImmutableGitSha;
    headSha: ImmutableGitSha;
  }>;
  services: readonly string[];
  images?: readonly PreviewProductionImage[];
  verification?: PreviewEnvironmentVerificationResult;
  cleanup?: PreviewEnvironmentCleanupProof | null;
  evidenceReceiptDigest?: `sha256:${string}`;
  stage?: string;
  message?: string;
}>;

export type PreviewAcceptanceCommitStatus =
  | "pending"
  | "success"
  | "failure"
  | "error";

export type PreviewCommitStatusContext =
  | "preview/gate"
  | "preview/immutable-acceptance"
  | "preview/activation-images";

export type PreviewGateSubordinateContext = Exclude<
  PreviewCommitStatusContext,
  "preview/gate"
>;

export type PreviewGateRequirements = Readonly<{
  catalogDigest: `sha256:${string}`;
  contexts: readonly PreviewGateSubordinateContext[];
  subjects: Readonly<Record<PreviewGateSubordinateContext, readonly string[]>>;
  requirementDigests: Readonly<
    Record<PreviewGateSubordinateContext, `sha256:${string}` | null>
  >;
  unmappedRuntimePaths: readonly string[];
}>;

export type PreviewGateCatalogService = Readonly<{
  service: string;
  changedPaths: readonly string[];
  acceptanceBuild: boolean;
  acceptanceReplay: boolean;
  activationBuild: boolean;
}>;

export type PreviewGateCatalogSnapshot = Readonly<{
  catalogDigest: `sha256:${string}`;
  pathPolicy: Readonly<{
    ignoredPathPrefixes: readonly string[];
    unsupportedPathPrefixes: readonly string[];
    unmatchedPathPolicy: "unsupported";
  }>;
  services: readonly PreviewGateCatalogService[];
}>;

export interface PreviewGateRequirementCatalogPort {
  currentDigest(): `sha256:${string}`;
  deriveGateRequirements(paths: readonly string[]): PreviewGateRequirements;
}

/** Reads the trusted catalog identity at an exact Git base commit. */
export interface PreviewGateBaseCatalogPort {
  loadAt(
    input: Readonly<{
      repository: string;
      baseSha: ImmutableGitSha;
    }>,
  ): Promise<PreviewGateCatalogSnapshot>;
}

export type PreviewAcceptanceCommitStatusInput = Readonly<{
  repository: string;
  pullRequestNumber: number;
  baseSha: ImmutableGitSha;
  headSha: ImmutableGitSha;
  context: PreviewCommitStatusContext;
  state: PreviewAcceptanceCommitStatus;
  description: string;
  requirementDigest?: `sha256:${string}`;
  evidenceReceiptDigest?: `sha256:${string}`;
}>;

/** Physical-only outbound port for exact PR-head preview governance statuses. */
export interface PreviewAcceptanceCommitStatusPort {
  publish(input: PreviewAcceptanceCommitStatusInput): Promise<void>;
  latest(
    input: Readonly<{
      repository: string;
      pullRequestNumber: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
      contexts: readonly PreviewGateSubordinateContext[];
      requirementDigests: Readonly<
        Record<PreviewGateSubordinateContext, `sha256:${string}` | null>
      >;
      evidenceReceiptDigests: Readonly<
        Record<PreviewGateSubordinateContext, `sha256:${string}` | null>
      >;
    }>,
  ): Promise<
    Readonly<
      Record<
        PreviewGateSubordinateContext,
        PreviewAcceptanceCommitStatus | null
      >
    >
  >;
}

export interface PreviewGateReconcilerPort {
  reconcile(
    input: Readonly<{
      repository: string;
      number: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
    }>,
  ): Promise<void>;
}

export interface PreviewAcceptanceBrokerPort {
  replay(
    input: PreviewAcceptanceBrokerRequest,
  ): Promise<PreviewAcceptanceBrokerResult>;
}
