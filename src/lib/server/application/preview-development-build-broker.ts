import type {
  ImmutableGitSha,
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptancePromotionPreparationPort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlSourceAuthorityPort,
  PreviewDevelopmentBrokerRequest,
  PreviewDevelopmentBrokerResult,
  PreviewEnvironmentDevelopmentImageBuildPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
  PreviewImportedArtifactIdentity,
  PreviewScopedDevelopmentBrokerRequest,
  SourceBundlePromotionRunnerPort,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DEVELOPMENT_BRANCH = /^preview-development-[0-9]{1,20}$/;

export class PreviewDevelopmentBrokerInputError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409 | 502 = 400,
    public readonly stage: "input" | "artifact" | "materialization" = "input",
  ) {
    super(message);
    this.name = "PreviewDevelopmentBrokerInputError";
  }
}

type PreviewDevelopmentBuildBrokerDeps = Readonly<{
  authority: PreviewControlSourceAuthorityPort;
  trust: PreviewAcceptancePromotionPreparationPort;
  promotions: SourceBundlePromotionRunnerPort;
  git: PreviewControlGitSourceVerificationPort;
  images: PreviewEnvironmentDevelopmentImageBuildPort;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort &
    PreviewAcceptanceChangedServiceCatalogPort;
  sourceRepository: string;
  baseBranch: string;
}>;

/**
 * Physical-control-plane coordinator for development source materialization and
 * immutable image builds. The mutable preview submits only a central artifact ID;
 * repository, base, promotion mode, branch prefix, and write credentials are
 * server-owned on this side of the broker boundary.
 */
export class ApplicationPreviewDevelopmentBuildBrokerService {
  constructor(private readonly deps: PreviewDevelopmentBuildBrokerDeps) {}

  async build(
    input: PreviewScopedDevelopmentBrokerRequest,
  ): Promise<PreviewDevelopmentBrokerResult> {
    this.validateInput(input);
    let services: readonly string[];
    try {
      services = this.deps.catalog.assertPreviewNativeServices(input.services);
    } catch (cause) {
      throw new PreviewDevelopmentBrokerInputError(message(cause));
    }
    const catalogDigest = this.deps.catalog.currentDigest();
    if (input.catalogDigest !== catalogDigest) {
      throw new PreviewDevelopmentBrokerInputError(
        "catalogDigest is not current",
        409,
        "artifact",
      );
    }

    const authorized = await this.deps.authority.authorize({
      previewName: input.previewName,
      environmentRequestId: input.environmentRequestId,
      environmentPlatformRevision: input.environmentPlatformRevision,
      environmentSourceRevision: input.environmentSourceRevision,
      catalogDigest: input.catalogDigest,
      requiredServices: services,
    });
    if (
      authorized.previewName !== input.previewName ||
      authorized.requestId !== input.environmentRequestId ||
      authorized.platformRevision !== input.environmentPlatformRevision ||
      authorized.sourceRevision !== input.environmentSourceRevision ||
      authorized.catalogDigest !== input.catalogDigest ||
      !sameStrings(authorized.services, services)
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "physical source authority returned a different preview identity",
        409,
        "artifact",
      );
    }
    const artifactIdentity = input.artifactIdentity;
    let prepared;
    try {
      prepared = await this.deps.trust.preparePromotion({
        artifact: {
          artifactId: input.artifactId,
          identity: artifactIdentity,
        },
        repo: this.deps.sourceRepository,
        base: this.deps.baseBranch,
      });
    } catch (cause) {
      throw new PreviewDevelopmentBrokerInputError(
        `development source artifact was rejected: ${message(cause)}`,
        409,
        "artifact",
      );
    }
    if (
      prepared.artifactId !== input.artifactId ||
      !sameImportedIdentity(prepared.artifactIdentity, artifactIdentity) ||
      prepared.catalogDigest !== catalogDigest ||
      prepared.platformRevision !== authorized.platformRevision ||
      prepared.capturedSourceRevision !== authorized.sourceRevision ||
      !sameStrings(prepared.services, services)
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "development source artifact does not match the authorized physical preview",
        409,
        "artifact",
      );
    }

    const promotion = await this.deps.promotions.promoteSourceBundle({
      executionId: input.executionId,
      fileId: prepared.fileId,
      repo: this.deps.sourceRepository,
      base: this.deps.baseBranch,
      baseRevision: prepared.capturedSourceRevision,
      mode: "branch",
      title: `Preview development build (${services.join(", ")})`,
      tier: "tar-overlay-set",
      repoSubdir: "",
      syncPaths: [],
      branchPrefix: "preview-development",
    });
    if (promotion.status !== "ok") {
      throw new PreviewDevelopmentBrokerInputError(
        promotion.status === "unavailable"
          ? promotion.message
          : promotion.error,
        502,
        "materialization",
      );
    }
    if (
      !promotion.branch ||
      !DEVELOPMENT_BRANCH.test(promotion.branch) ||
      !FULL_SHA.test(promotion.commitSha) ||
      promotion.commitSha === prepared.capturedSourceRevision ||
      promotion.baseRevision !== prepared.capturedSourceRevision ||
      promotion.pullRequestBase !== this.deps.baseBranch ||
      !validChangedPaths(promotion.changedPaths)
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "development materialization returned invalid Git provenance",
        502,
        "materialization",
      );
    }
    const sourceRevision = promotion.commitSha as ImmutableGitSha;
    if (
      !(await this.deps.git.verifyBranch({
        repository: this.deps.sourceRepository,
        branch: promotion.branch,
        commitSha: sourceRevision,
        baseBranch: this.deps.baseBranch,
        baseRevision: prepared.capturedSourceRevision as ImmutableGitSha,
      }))
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "GitHub branch does not resolve to the materialized candidate commit",
        409,
        "materialization",
      );
    }
    const changed = this.deps.catalog.deriveChangedServices(
      promotion.changedPaths,
    );
    if (changed.unmappedRuntimePaths.length > 0) {
      throw new PreviewDevelopmentBrokerInputError(
        `materialized candidate changes unmapped runtime paths: ${changed.unmappedRuntimePaths.join(", ")}`,
        409,
        "materialization",
      );
    }
    let affectedServices: readonly string[];
    try {
      affectedServices = this.deps.catalog.assertPreviewNativeServices(
        changed.services,
      );
    } catch (cause) {
      throw new PreviewDevelopmentBrokerInputError(
        `materialized candidate has no supported preview-native service closure: ${message(cause)}`,
        409,
        "materialization",
      );
    }
    const missingOverlays = affectedServices.filter(
      (service) => !services.includes(service),
    );
    if (missingOverlays.length > 0) {
      throw new PreviewDevelopmentBrokerInputError(
        `materialized candidate affects services without captured overlays: ${missingOverlays.join(", ")}`,
        409,
        "materialization",
      );
    }

    const operationId = [
      "preview-development",
      input.previewName,
      sourceRevision,
      affectedServices.join("."),
    ].join(":");
    console.info(
      `[preview-control] development build audit=${input.requestId} operation=${operationId}`,
    );
    const settled = await Promise.allSettled(
      affectedServices.map((service) =>
        this.deps.images.build({
          requestId: operationId,
          sourceRepository: this.deps.sourceRepository,
          sourceRevision,
          catalogDigest,
          service,
        }),
      ),
    );
    const results = affectedServices.map((service, index) => {
      const result = settled[index];
      if (!result || result.status === "rejected") {
        return Object.freeze({
          service,
          ok: false as const,
          error: message(result?.reason ?? "build result missing"),
        });
      }
      return Object.freeze({ service, ok: true as const, image: result.value });
    });
    return Object.freeze({
      ok: results.every((result) => result.ok),
      previewName: input.previewName,
      branch: promotion.branch,
      sourceRevision,
      baselineRevision: prepared.capturedSourceRevision as ImmutableGitSha,
      pullRequestBase: promotion.pullRequestBase,
      changedPaths: Object.freeze([...promotion.changedPaths]),
      catalogDigest,
      services: Object.freeze(results),
    });
  }

  private validateInput(input: PreviewDevelopmentBrokerRequest): void {
    if (!SAFE_ID.test(input.requestId)) {
      throw new PreviewDevelopmentBrokerInputError("requestId is invalid");
    }
    if (!SAFE_ID.test(input.executionId)) {
      throw new PreviewDevelopmentBrokerInputError("executionId is invalid");
    }
    if (!SAFE_ID.test(input.artifactId)) {
      throw new PreviewDevelopmentBrokerInputError("artifactId is invalid");
    }
    if (!PREVIEW_NAME.test(input.previewName)) {
      throw new PreviewDevelopmentBrokerInputError("previewName is invalid");
    }
    if (
      !input.artifactIdentity ||
      !validImportedIdentity(input.artifactIdentity)
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "complete imported artifact identity is required",
      );
    }
    if (
      !SAFE_ID.test(input.environmentRequestId ?? "") ||
      !FULL_SHA.test(input.environmentPlatformRevision ?? "") ||
      !FULL_SHA.test(input.environmentSourceRevision ?? "")
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "preview environment capability identity is invalid",
      );
    }
    if (
      input.artifactIdentity.previewName !== input.previewName ||
      input.artifactIdentity.requestId !== input.environmentRequestId ||
      input.artifactIdentity.executionId !== input.executionId ||
      input.artifactIdentity.platformRevision !==
        input.environmentPlatformRevision ||
      input.artifactIdentity.sourceRevision !==
        input.environmentSourceRevision ||
      input.artifactIdentity.catalogDigest !== input.catalogDigest ||
      !sameStrings(input.artifactIdentity.services, input.services)
    ) {
      throw new PreviewDevelopmentBrokerInputError(
        "imported artifact identity does not match the broker request",
      );
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const canonicalLeft = [...left].sort();
  const canonicalRight = [...right].sort();
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((value, index) => value === canonicalRight[index])
  );
}

function validImportedIdentity(
  identity: PreviewImportedArtifactIdentity,
): boolean {
  return (
    PREVIEW_NAME.test(identity.previewName) &&
    SAFE_ID.test(identity.requestId) &&
    SAFE_ID.test(identity.executionId) &&
    SAFE_ID.test(identity.sourceArtifactId) &&
    FULL_SHA.test(identity.platformRevision) &&
    FULL_SHA.test(identity.sourceRevision) &&
    /^sha256:[0-9a-f]{64}$/.test(identity.catalogDigest) &&
    /^sha256:[0-9a-f]{64}$/.test(identity.fileDigest) &&
    SAFE_ID.test(identity.captureId) &&
    SAFE_ID.test(identity.generation) &&
    Array.isArray(identity.services) &&
    identity.services.length > 0 &&
    identity.services.every((service) => SAFE_ID.test(service)) &&
    new Set(identity.services).size === identity.services.length
  );
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

function validChangedPaths(paths: readonly string[]): boolean {
  return (
    Array.isArray(paths) &&
    paths.length > 0 &&
    paths.length <= 10_000 &&
    new Set(paths).size === paths.length &&
    paths.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.includes("\0") &&
        !path.split("/").includes(".."),
    )
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
