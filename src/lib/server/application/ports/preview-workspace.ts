import type { PreviewControlIdentity } from "./preview-control";

/** Action catalog entries backed by ApplicationPreviewWorkspaceService. */
export const PREVIEW_WORKSPACE_ACTION_SLUGS = [
  "dev/preview-workspace-seed",
  "dev/preview-workspace-sync",
  "dev/preview-sidecar-run",
] as const;

export type PreviewWorkspaceExecutionBinding = Readonly<{
  version: 1;
  target: Readonly<{
    previewName: string;
    environmentRequestId: string;
    platformRevision: string;
    sourceRevision: string;
    catalogDigest: `sha256:${string}`;
  }>;
}>;

export type PreviewWorkspaceStageMapping = Readonly<{
  from: string;
  to: string;
}>;

/** Credential-free source plan resolved from the server-owned preview catalog. */
export type PreviewWorkspaceSourcePlan = Readonly<{
  service: string;
  repository: string;
  repoSubdir: string;
  syncPaths: readonly string[];
  stageMappings: readonly PreviewWorkspaceStageMapping[];
  allowedCommands: readonly string[];
}>;

export interface PreviewWorkspaceCatalogPort {
  resolve(service: string | null | undefined): PreviewWorkspaceSourcePlan;
}

export type PreviewWorkspaceSeedCommand = Readonly<{
  executionId: string;
  workspaceKey: string;
  repository: string;
  sourceRevision: string;
  repoSubdir: string;
  sourceBundle: Uint8Array;
  sourceBundleSha256: `sha256:${string}`;
  sourceFileCount: number;
}>;

export type PreviewWorkspaceSourceBundleRequest = Readonly<{
  identity: PreviewControlIdentity;
  service: string;
}>;

export type PreviewWorkspaceGitBundleRequest = Readonly<{
  repository: string;
  sourceRevision: string;
}>;

export type PreviewWorkspaceSourceBundle = Readonly<{
  repository: string;
  sourceRevision: string;
  bundle: Uint8Array;
  bundleSha256: `sha256:${string}`;
  fileCount: number;
}>;

/** Mutable-preview client boundary to the tuple-authorized physical source broker. */
export interface PreviewWorkspaceSourceBundlePort {
  fetchExact(
    request: PreviewWorkspaceSourceBundleRequest,
  ): Promise<PreviewWorkspaceSourceBundle>;
}

/** Physical-only Git bundle boundary. Credentials never cross this port. */
export interface PreviewWorkspaceGitBundlePort {
  fetchExact(
    request: PreviewWorkspaceGitBundleRequest,
  ): Promise<PreviewWorkspaceSourceBundle>;
}

export class PreviewWorkspaceGatewayError extends Error {
  constructor(
    public readonly code:
      | "source-unavailable"
      | "source-rejected"
      | "helper-unavailable"
      | "helper-rejected"
      | "helper-invalid-receipt"
      | "helper-cleanup-failed",
    public readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "PreviewWorkspaceGatewayError";
  }
}

export type PreviewWorkspaceCaptureCommand = Readonly<{
  executionId: string;
  workspaceKey: string;
  sourceRevision: string;
  repoSubdir: string;
  syncPaths: readonly string[];
  stageMappings: readonly PreviewWorkspaceStageMapping[];
  diffScope: readonly string[] | null;
}>;

export type PreviewWorkspaceSeedResult = Readonly<{
  reused: boolean;
  fileCount: number;
}>;

export type PreviewWorkspaceCaptureResult = Readonly<{
  archive: Uint8Array;
  archiveSha256: `sha256:${string}`;
  changedPaths: readonly string[];
  fileCount: number;
}>;

/**
 * Outbound shared-workspace boundary. Implementations own the one-shot helper
 * lifecycle; callers never supply a command, path, URL, or credential.
 */
export interface PreviewWorkspaceGatewayPort {
  seed(
    command: PreviewWorkspaceSeedCommand,
  ): Promise<PreviewWorkspaceSeedResult>;
  capture(
    command: PreviewWorkspaceCaptureCommand,
  ): Promise<PreviewWorkspaceCaptureResult>;
}

export type PreviewWorkspaceAuthority = Readonly<{
  executionId: string;
  userId: string;
  projectId: string;
  identity: PreviewControlIdentity;
  service: string;
  workspaceKey: string;
  sourceRevision: string;
  source: PreviewWorkspaceSourcePlan;
  diffScope: readonly string[] | null;
}>;
