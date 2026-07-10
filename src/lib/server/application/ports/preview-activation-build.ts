import type { ImmutableGitSha } from "./preview-environments";

export type PreviewActivationArtifact = "dev-sync-sidecar";

export type PreviewActivationImage = Readonly<{
  artifact: PreviewActivationArtifact;
  sourceRevision: ImmutableGitSha;
  pipelineRun: string;
  imageRef: string;
  digest: `sha256:${string}`;
  immutableRef: string;
}>;

/** Build-only port for exact-head preview activation artifacts. */
export interface PreviewActivationImageBuildPort {
  build(
    input: Readonly<{
      requestId: string;
      artifact: PreviewActivationArtifact;
      sourceRepository: "PittampalliOrg/workflow-builder";
      sourceRevision: ImmutableGitSha;
      catalogDigest: `sha256:${string}`;
    }>,
  ): Promise<PreviewActivationImage>;
}

export type PreviewActivationGateRequest = Readonly<{
  requestId: string;
  catalogDigest: `sha256:${string}`;
  pullRequest: Readonly<{
    repository: string;
    number: number;
    baseSha: ImmutableGitSha;
    headSha: ImmutableGitSha;
  }>;
}>;

export type PreviewActivationGateResult = Readonly<{
  ok: true;
  pullRequest: PreviewActivationGateRequest["pullRequest"];
  catalogDigest: `sha256:${string}`;
  evidenceReceiptDigest: `sha256:${string}`;
  images: readonly PreviewActivationImage[];
}>;

/** Physical application boundary for finalizing activation-image evidence. */
export interface PreviewActivationGatePort {
  buildAndFinalize(
    input: PreviewActivationGateRequest,
  ): Promise<PreviewActivationGateResult>;
}
