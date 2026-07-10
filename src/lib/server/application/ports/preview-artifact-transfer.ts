import type {
  PreviewAcceptanceArtifactSnapshot,
  PreviewImportedArtifactIdentity,
  PreviewImportedArtifactLookup,
} from "./preview-acceptance-trust";
import type { PreviewControlIdentity } from "./preview-control";

export type PreviewArtifactTransferEnvelope = Readonly<{
  identity: PreviewControlIdentity;
  executionId: string;
  artifactId: string;
  fileDigest: `sha256:${string}`;
  artifact: PreviewAcceptanceArtifactSnapshot;
}>;

export type PreviewControlArtifactRecord = Readonly<{
  id: string;
  fileId: string;
  fileDigest: `sha256:${string}`;
  artifact: PreviewAcceptanceArtifactSnapshot;
  importIdentity: PreviewImportedArtifactIdentity;
}>;

export type PreviewArtifactCaptureMapping = Readonly<{
  from: string;
  to: string;
}>;

export type PreviewArtifactServiceCaptureContract = Readonly<{
  service: string;
  repository: string;
  base: string;
  repoSubdir: string;
  syncPaths: readonly string[];
  captureMappings: readonly PreviewArtifactCaptureMapping[];
}>;

/** Catalog-owned reconstruction policy used at the physical artifact boundary. */
export interface PreviewArtifactCaptureCatalogPort {
  currentDigest(): `sha256:${string}`;
  captureContract(
    service: string,
  ): PreviewArtifactServiceCaptureContract | null;
}

export interface PreviewArtifactExportPort {
  load(
    input: Readonly<{
      executionId: string;
      artifactId: string;
    }>,
  ): Promise<Readonly<{
    artifact: PreviewAcceptanceArtifactSnapshot;
    bytes: Buffer;
    fileDigest: `sha256:${string}`;
  }> | null>;
}

export interface PreviewControlArtifactStorePort {
  put(
    input: Readonly<{
      envelope: PreviewArtifactTransferEnvelope;
      bytes: Buffer;
      ownerId: string;
      captureId: string;
      generation: string;
      services: readonly string[];
    }>,
  ): Promise<PreviewControlArtifactRecord>;
  get(
    input: PreviewImportedArtifactLookup,
  ): Promise<PreviewControlArtifactRecord | null>;
  fileDigest(
    input: PreviewImportedArtifactLookup & Readonly<{ fileId: string }>,
  ): Promise<`sha256:${string}` | null>;
}

export interface PreviewArtifactIngressPort {
  ingest(
    envelope: PreviewArtifactTransferEnvelope,
    bytes: Buffer,
  ): Promise<PreviewControlArtifactRecord>;
}

export interface PreviewArtifactTransferPort {
  transfer(
    input: Readonly<{
      identity: PreviewControlIdentity;
      executionId: string;
      artifactId: string;
    }>,
  ): Promise<PreviewControlArtifactRecord>;
}
