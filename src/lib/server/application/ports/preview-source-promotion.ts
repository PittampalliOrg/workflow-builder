import type { PreviewImportedArtifactIdentity } from "./preview-acceptance-trust";
import type { ImmutableGitSha } from "./preview-environments";

export type PreviewSourcePromotionBrokerRequest = Readonly<{
  operationId: string;
  previewName: string;
  environmentRequestId: string;
  environmentPlatformRevision: string;
  environmentSourceRevision: string;
  catalogDigest: `sha256:${string}`;
  executionId: string;
  artifactId: string;
  artifactIdentity: PreviewImportedArtifactIdentity;
  title: string | null;
  bodyMarkdown: string | null;
  draft: boolean;
}>;

export type PreviewSourcePromotionResult = Readonly<{
  ok: true;
  receiptId: string;
  previewName: string;
  requestId: string;
  executionId: string;
  artifactId: string;
  services: readonly string[];
  branch: string;
  commitSha: ImmutableGitSha;
  prUrl: string;
  pullRequest: Readonly<{
    repository: string;
    number: number;
    baseSha: ImmutableGitSha;
    headSha: ImmutableGitSha;
  }>;
  draft: boolean;
}>;

export type PreviewSourcePromotionReceiptInput = Readonly<{
  artifactId: string;
  previewName: string;
  requestId: string;
  executionId: string;
  platformRevision: ImmutableGitSha;
  /** Immutable source baseline captured by the preview and used as the promoted commit parent. */
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  repository: string;
  baseBranch: string;
  /** Live head of baseBranch observed on the exact GitHub PR tuple for this receipt. */
  baseSha: ImmutableGitSha;
  branch: string;
  commitSha: ImmutableGitSha;
  prUrl: string;
  pullRequestNumber: number;
  draft: true;
  services: readonly string[];
  changedPaths: readonly string[];
}>;

export type PreviewSourcePromotionReceipt = PreviewSourcePromotionReceiptInput &
  Readonly<{
    receiptId: string;
    createdAt: string;
  }>;

export type PreviewSourcePromotionReceiptScope = Readonly<{
  previewName: string;
  requestId: string;
  executionId: string;
  platformRevision: ImmutableGitSha;
  sourceRevision: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  repository: string;
  baseBranch: string;
}>;

/** Physical durable receipt store. Mutable preview deployments never receive this port. */
export interface PreviewSourcePromotionReceiptStorePort {
  put(
    input: PreviewSourcePromotionReceiptInput,
  ): Promise<PreviewSourcePromotionReceipt>;
  getByArtifact(artifactId: string): Promise<PreviewSourcePromotionReceipt | null>;
  getScoped(
    input: PreviewSourcePromotionReceiptScope & Readonly<{ receiptId: string }>,
  ): Promise<PreviewSourcePromotionReceipt | null>;
  getLatestForExecution(
    input: PreviewSourcePromotionReceiptScope,
  ): Promise<PreviewSourcePromotionReceipt | null>;
}

/** The promotion scope is already being materialized by another broker request. */
export class PreviewSourcePromotionExclusivityBusyError extends Error {
  constructor() {
    super("preview source promotion is busy; retry the checkpoint");
    this.name = "PreviewSourcePromotionExclusivityBusyError";
  }
}

/**
 * Cross-replica single-flight boundary for every generation of one stable
 * preview PR.
 */
export interface PreviewSourcePromotionExclusivityPort {
  runExclusive<T>(
    scope: PreviewSourcePromotionReceiptScope,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export interface PreviewSourcePromotionBrokerPort {
  promote(
    input: PreviewSourcePromotionBrokerRequest,
  ): Promise<PreviewSourcePromotionResult>;
}

export interface PreviewSourcePromotionPort {
  promote(
    input: Readonly<{
      executionId: string;
      artifactId: string;
      title?: string | null;
      bodyMarkdown?: string | null;
      draft?: boolean;
    }>,
  ): Promise<PreviewSourcePromotionResult>;
}
