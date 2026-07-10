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
