import type { PreviewGateSubordinateContext } from "./preview-control";
import type { ImmutableGitSha } from "./preview-environments";

/** One exact image proven by a physical preview acceptance lane. */
export type PreviewAcceptedImageSubject = Readonly<{
  subject: string;
  sourceRevision: ImmutableGitSha;
  buildRun: string;
  imageRef: string;
  digest: `sha256:${string}`;
  immutableRef: string;
}>;

/** Immutable evidence written before a terminal subordinate status is published. */
export type PreviewAcceptedImageReceiptInput = Readonly<{
  repository: string;
  pullRequestNumber: number;
  baseSha: ImmutableGitSha;
  headSha: ImmutableGitSha;
  catalogDigest: `sha256:${string}`;
  context: PreviewGateSubordinateContext;
  subjects: readonly PreviewAcceptedImageSubject[];
}>;

export type PreviewAcceptedImageReceiptContent =
  PreviewAcceptedImageReceiptInput &
    Readonly<{
      receiptDigest: `sha256:${string}`;
    }>;

export type PreviewAcceptedImageReceipt = PreviewAcceptedImageReceiptContent &
  Readonly<{
    attestation: `v1.${string}`;
    createdAt: string;
  }>;

/** Purpose-separated cryptographic provenance; database integrity alone is insufficient. */
export interface PreviewAcceptedImageReceiptAttestationPort {
  attest(input: PreviewAcceptedImageReceiptContent): `v1.${string}`;
  verify(input: PreviewAcceptedImageReceipt): boolean;
}

export type PreviewAcceptedImageReceiptLookup = Readonly<{
  repository: string;
  pullRequestNumber: number;
  baseSha: ImmutableGitSha;
  headSha: ImmutableGitSha;
  context: PreviewGateSubordinateContext;
}>;

/** Physical durable evidence store. Mutable preview deployments never receive this port. */
export interface PreviewAcceptedImageReceiptStorePort {
  put(
    input: PreviewAcceptedImageReceiptInput,
  ): Promise<PreviewAcceptedImageReceipt>;
  getByRepoPrHeadContext(
    input: PreviewAcceptedImageReceiptLookup,
  ): Promise<PreviewAcceptedImageReceipt | null>;
}

export type PreviewMergedCommitInspection = Readonly<{
  repository: string;
  pullRequestNumber: number;
  baseSha: ImmutableGitSha;
  headSha: ImmutableGitSha;
  mergeSha: ImmutableGitSha;
  baseRef: string;
  headTreeSha: ImmutableGitSha;
  mergeTreeSha: ImmutableGitSha;
  changedPaths: readonly string[];
}>;

/** Git-provider boundary proving which merged PR produced one commit on the protected base. */
export interface PreviewMergedCommitInspectionPort {
  inspect(
    input: Readonly<{
      repository: string;
      mergeSha: ImmutableGitSha;
    }>,
  ): Promise<PreviewMergedCommitInspection | null>;
}

export type PreviewAcceptedImageReuseRequest = Readonly<{
  repository: string;
  mergeSha: ImmutableGitSha;
  context: PreviewGateSubordinateContext;
  subject: string;
}>;

export type PreviewAcceptedImageReuseResult =
  | Readonly<{
      ok: true;
      disposition: "reuse";
      mergeSha: ImmutableGitSha;
      pullRequestNumber: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
      receiptDigest: `sha256:${string}`;
      image: PreviewAcceptedImageSubject;
    }>
  | Readonly<{
      ok: false;
      disposition: "build";
      reason:
        | "merge-not-proven"
        | "content-drift"
        | "receipt-absent"
        | "receipt-untrusted"
        | "catalog-drift"
        | "subject-drift"
        | "subject-absent";
    }>;

/** Build preflight: returns a reusable image only when all immutable evidence agrees. */
export interface PreviewAcceptedImageReusePort {
  resolve(
    input: PreviewAcceptedImageReuseRequest,
  ): Promise<PreviewAcceptedImageReuseResult>;
}
