/** Legacy metadata marker retained only to reject pre-broker attested artifacts. */
export const PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY =
  "previewAcceptanceAttestationV1";

export type PreviewAcceptanceArtifactSnapshot = Readonly<{
  id: string;
  executionId: string;
  kind: string;
  fileId: string | null;
  inlinePayload: unknown;
  metadata: Record<string, unknown> | null;
  /** Present for artifacts imported across the preview-control boundary. */
  importIdentity?: PreviewImportedArtifactIdentity;
}>;

/**
 * Immutable identity of one artifact imported from an isolated preview database.
 * `artifactId` in a lookup is the physical record id; `sourceArtifactId` remains
 * the id minted inside the preview so the two namespaces cannot be confused.
 */
export type PreviewImportedArtifactIdentity = Readonly<{
  previewName: string;
  requestId: string;
  executionId: string;
  sourceArtifactId: string;
  platformRevision: string;
  sourceRevision: string;
  catalogDigest: `sha256:${string}`;
  services: readonly string[];
  captureId: string;
  generation: string;
  fileDigest: `sha256:${string}`;
}>;

export type PreviewImportedArtifactLookup = Readonly<{
  artifactId: string;
  identity: PreviewImportedArtifactIdentity;
}>;

export interface PreviewAcceptanceCatalogDigestPort {
  currentDigest(): `sha256:${string}`;
}

export type PreparedPreviewAcceptancePromotion = Readonly<{
  artifactId: string;
  artifactIdentity: PreviewImportedArtifactIdentity;
  fileId: string;
  fileDigest: `sha256:${string}`;
  services: readonly string[];
  catalogDigest: `sha256:${string}`;
  repo: string;
  base: string;
  capturedSourceRevision: string;
  platformRevision: string;
}>;

/** Strict central-artifact validation before physical branch materialization. */
export interface PreviewAcceptancePromotionPreparationPort {
  preparePromotion(input: {
    artifact: PreviewImportedArtifactLookup;
    repo: string;
    base: string;
  }): Promise<PreparedPreviewAcceptancePromotion>;
}

export interface PreviewAcceptanceArtifactPort {
  get(
    input: PreviewImportedArtifactLookup,
  ): Promise<PreviewAcceptanceArtifactSnapshot | null>;
  fileDigest(
    input: PreviewImportedArtifactLookup & Readonly<{ fileId: string }>,
  ): Promise<`sha256:${string}` | null>;
}
