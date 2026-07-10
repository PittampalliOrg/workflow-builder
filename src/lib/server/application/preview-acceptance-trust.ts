import {
  PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY,
  type PreviewAcceptanceArtifactPort,
  type PreviewAcceptanceArtifactSnapshot,
  type PreviewAcceptanceCatalogDigestPort,
  type PreviewAcceptancePromotionPreparationPort,
  type PreviewImportedArtifactIdentity,
  type PreviewImportedArtifactLookup,
  type PreparedPreviewAcceptancePromotion,
} from "$lib/server/application/ports/preview-acceptance-trust";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type PreviewAcceptanceTrustErrorCode =
  | "artifact-not-found"
  | "not-strict-capture"
  | "file-not-found"
  | "repository-mismatch"
  | "base-mismatch"
  | "catalog-mismatch"
  | "identity-mismatch"
  | "file-digest-mismatch"
  | "already-attested";

export class PreviewAcceptanceTrustError extends Error {
  constructor(
    public readonly code: PreviewAcceptanceTrustErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewAcceptanceTrustError";
  }
}

export type StrictPreviewCapture = Readonly<{
  captureId: string;
  generation: string;
  catalogDigest: `sha256:${string}`;
  services: readonly string[];
  repo: string;
  base: string;
  capturedSourceRevision: string;
  platformRevision: string;
}>;

type PreviewAcceptanceTrustDeps = Readonly<{
  artifacts: PreviewAcceptanceArtifactPort;
  catalog: PreviewAcceptanceCatalogDigestPort;
}>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sortedServices(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.some((service) => typeof service !== "string" || !service.trim()))
    return null;
  const services = (value as string[]).map((service) => service.trim());
  if (new Set(services).size !== services.length) return null;
  return [...services].sort();
}

export function parseStrictPreviewCapture(
  artifact: PreviewAcceptanceArtifactSnapshot,
): StrictPreviewCapture | null {
  if (artifact.kind !== "source-bundle" || !artifact.fileId) return null;
  const payload = record(artifact.inlinePayload);
  const captureId = text(payload.captureId);
  const generation = text(payload.generation);
  const catalogDigest = text(payload.catalogDigest);
  const repo = text(payload.repoUrl);
  const base = text(payload.base);
  const capturedSourceRevision = text(payload.sourceRevision);
  const platformRevision = text(payload.platformRevision);
  const services = sortedServices(payload.services);
  if (
    payload.acceptanceEligible !== true ||
    payload.captureProtocol !== "atomic-generation-v2" ||
    payload.manifestVersion !== 2 ||
    !captureId ||
    !generation ||
    !GENERATION.test(generation) ||
    !catalogDigest ||
    !SHA256.test(catalogDigest) ||
    !repo ||
    !REPOSITORY.test(repo) ||
    !base ||
    !capturedSourceRevision ||
    !FULL_SHA.test(capturedSourceRevision) ||
    !platformRevision ||
    !FULL_SHA.test(platformRevision) ||
    !services
  ) {
    return null;
  }
  const overlayDigests = record(payload.overlayDigests);
  if (
    Object.keys(overlayDigests).length !== services.length ||
    services.some(
      (service) =>
        typeof overlayDigests[service] !== "string" ||
        !SHA256.test(overlayDigests[service] as string),
    )
  ) {
    return null;
  }
  return {
    captureId,
    generation,
    catalogDigest: catalogDigest as `sha256:${string}`,
    services,
    repo,
    base,
    capturedSourceRevision,
    platformRevision,
  };
}

export class ApplicationPreviewAcceptanceTrustService implements PreviewAcceptancePromotionPreparationPort {
  constructor(private readonly deps: PreviewAcceptanceTrustDeps) {}

  async preparePromotion(input: {
    artifact: PreviewImportedArtifactLookup;
    repo: string;
    base: string;
  }): Promise<PreparedPreviewAcceptancePromotion> {
    const artifact = await this.deps.artifacts.get(input.artifact);
    if (!artifact) {
      throw new PreviewAcceptanceTrustError(
        "artifact-not-found",
        "source bundle artifact was not found",
      );
    }
    const capture = parseStrictPreviewCapture(artifact);
    if (!capture || !artifact.fileId) {
      throw new PreviewAcceptanceTrustError(
        "not-strict-capture",
        "source bundle is not an immutable atomic capture",
      );
    }
    if (
      artifact.id !== input.artifact.artifactId ||
      artifact.executionId !== input.artifact.identity.executionId ||
      !artifact.importIdentity ||
      !sameImportedIdentity(artifact.importIdentity, input.artifact.identity) ||
      capture.captureId !== input.artifact.identity.captureId ||
      capture.generation !== input.artifact.identity.generation ||
      capture.platformRevision !== input.artifact.identity.platformRevision ||
      capture.capturedSourceRevision !==
        input.artifact.identity.sourceRevision ||
      capture.catalogDigest !== input.artifact.identity.catalogDigest ||
      !sameStrings(capture.services, input.artifact.identity.services)
    ) {
      throw new PreviewAcceptanceTrustError(
        "identity-mismatch",
        "source bundle does not match the complete imported artifact identity",
      );
    }
    if (capture.repo !== input.repo) {
      throw new PreviewAcceptanceTrustError(
        "repository-mismatch",
        "promotion repository does not match the captured repository",
      );
    }
    if (capture.base !== input.base) {
      throw new PreviewAcceptanceTrustError(
        "base-mismatch",
        "promotion base does not match the captured base",
      );
    }
    if (capture.catalogDigest !== this.deps.catalog.currentDigest()) {
      throw new PreviewAcceptanceTrustError(
        "catalog-mismatch",
        "capture catalog digest is not current",
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        artifact.metadata ?? {},
        PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY,
      )
    ) {
      throw new PreviewAcceptanceTrustError(
        "already-attested",
        "source bundle already has an acceptance attestation",
      );
    }
    const fileDigest = await this.deps.artifacts.fileDigest({
      ...input.artifact,
      fileId: artifact.fileId,
    });
    if (!fileDigest) {
      throw new PreviewAcceptanceTrustError(
        "file-not-found",
        "source bundle file was not found",
      );
    }
    if (fileDigest !== input.artifact.identity.fileDigest) {
      throw new PreviewAcceptanceTrustError(
        "file-digest-mismatch",
        "source bundle bytes do not match the imported artifact identity",
      );
    }
    return Object.freeze({
      artifactId: artifact.id,
      artifactIdentity: input.artifact.identity,
      fileId: artifact.fileId,
      fileDigest,
      services: Object.freeze([...capture.services]),
      catalogDigest: capture.catalogDigest,
      repo: capture.repo,
      base: capture.base,
      capturedSourceRevision: capture.capturedSourceRevision,
      platformRevision: capture.platformRevision,
    });
  }
}

function sameImportedIdentity(
  left: PreviewImportedArtifactIdentity,
  right: PreviewImportedArtifactIdentity,
): boolean {
  return (
    left.previewName === right.previewName &&
    left.requestId === right.requestId &&
    left.executionId === right.executionId &&
    left.sourceArtifactId === right.sourceArtifactId &&
    left.platformRevision === right.platformRevision &&
    left.sourceRevision === right.sourceRevision &&
    left.catalogDigest === right.catalogDigest &&
    left.captureId === right.captureId &&
    left.generation === right.generation &&
    left.fileDigest === right.fileDigest &&
    sameStrings(left.services, right.services)
  );
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const canonicalLeft = [...left].sort();
  const canonicalRight = [...right].sort();
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}
