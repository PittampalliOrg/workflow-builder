import type {
  ImmutableGitSha,
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptancePromotionPreparationPort,
  PreviewArtifactTransferPort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlPullRequestInspectionPort,
  PreviewControlSourceAuthorityPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
  PreviewImportedArtifactIdentity,
  PreviewLocalControlIdentityPort,
  PreviewSourcePromotionBrokerPort,
  PreviewSourcePromotionBrokerRequest,
  PreviewSourcePromotionPort,
  SourceBundlePromotionRunnerPort,
} from "$lib/server/application/ports";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MAX_TITLE = 240;
const MAX_BODY = 64 * 1024;

export class PreviewSourcePromotionError extends Error {
  constructor(
    public readonly code:
      | "invalid-request"
      | "authority-mismatch"
      | "artifact-rejected"
      | "materialization-failed",
    message: string,
    public readonly statusCode: 400 | 409 | 502,
  ) {
    super(message);
    this.name = "PreviewSourcePromotionError";
  }
}

/** Preview-side coordinator. It transfers bytes but owns no Git or GitHub port. */
export class ApplicationPreviewSourcePromotionService implements PreviewSourcePromotionPort {
  constructor(
    private readonly deps: Readonly<{
      identity: PreviewLocalControlIdentityPort;
      artifacts: PreviewArtifactTransferPort;
      broker: PreviewSourcePromotionBrokerPort;
    }>,
  ) {}

  async promote(input: {
    executionId: string;
    artifactId: string;
    title?: string | null;
    bodyMarkdown?: string | null;
    draft?: boolean;
  }) {
    validateLocalInput(input);
    const identity = this.deps.identity.current();
    const transferred = await this.deps.artifacts.transfer({
      identity,
      executionId: input.executionId,
      artifactId: input.artifactId,
    });
    const imported = transferred.importIdentity;
    if (
      imported.previewName !== identity.previewName ||
      imported.requestId !== identity.environmentRequestId ||
      imported.executionId !== input.executionId ||
      imported.sourceArtifactId !== input.artifactId ||
      imported.platformRevision !== identity.environmentPlatformRevision ||
      imported.sourceRevision !== identity.environmentSourceRevision ||
      imported.catalogDigest !== identity.catalogDigest
    ) {
      throw new PreviewSourcePromotionError(
        "artifact-rejected",
        "transferred artifact does not match the local preview generation",
        409,
      );
    }
    return this.deps.broker.promote({
      operationId: transferred.id,
      previewName: identity.previewName,
      environmentRequestId: identity.environmentRequestId,
      environmentPlatformRevision: identity.environmentPlatformRevision,
      environmentSourceRevision: identity.environmentSourceRevision,
      catalogDigest: identity.catalogDigest,
      executionId: input.executionId,
      artifactId: transferred.id,
      artifactIdentity: imported,
      title: cleanOptional(input.title),
      bodyMarkdown: cleanOptional(input.bodyMarkdown),
      draft: input.draft === true,
    });
  }
}

type BrokerDeps = Readonly<{
  authority: PreviewControlSourceAuthorityPort;
  trust: PreviewAcceptancePromotionPreparationPort;
  promotions: SourceBundlePromotionRunnerPort;
  git: PreviewControlGitSourceVerificationPort;
  pullRequests: PreviewControlPullRequestInspectionPort;
  catalog: PreviewEnvironmentVersionedServiceCatalogPort &
    PreviewAcceptanceChangedServiceCatalogPort;
  sourceRepository: string;
  baseBranch: string;
}>;

/** Physical coordinator. Only this side receives the GitHub write credential. */
export class ApplicationPreviewSourcePromotionBrokerService implements PreviewSourcePromotionBrokerPort {
  constructor(private readonly deps: BrokerDeps) {}

  async promote(
    input: PreviewSourcePromotionBrokerRequest,
  ): Promise<Awaited<ReturnType<PreviewSourcePromotionBrokerPort["promote"]>>> {
    validateBrokerInput(input);
    const services = this.deps.catalog.assertPreviewNativeServices(
      input.artifactIdentity.services,
    );
    const branchName = sourcePromotionBranch(input.operationId);
    if (input.catalogDigest !== this.deps.catalog.currentDigest()) {
      throw new PreviewSourcePromotionError(
        "authority-mismatch",
        "preview source promotion catalog is not current",
        409,
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
      throw new PreviewSourcePromotionError(
        "authority-mismatch",
        "physical source authority returned a different preview generation",
        409,
      );
    }

    let prepared;
    try {
      prepared = await this.deps.trust.preparePromotion({
        artifact: {
          artifactId: input.artifactId,
          identity: input.artifactIdentity,
        },
        repo: this.deps.sourceRepository,
        base: this.deps.baseBranch,
      });
    } catch (cause) {
      throw new PreviewSourcePromotionError(
        "artifact-rejected",
        `source artifact was rejected: ${message(cause)}`,
        409,
      );
    }
    if (
      prepared.artifactId !== input.artifactId ||
      !SAFE_ID.test(prepared.fileId) ||
      prepared.fileDigest !== input.artifactIdentity.fileDigest ||
      !sameArtifactIdentity(
        prepared.artifactIdentity,
        input.artifactIdentity,
      ) ||
      prepared.repo !== this.deps.sourceRepository ||
      prepared.base !== this.deps.baseBranch ||
      prepared.platformRevision !== authorized.platformRevision ||
      prepared.capturedSourceRevision !== authorized.sourceRevision ||
      prepared.catalogDigest !== authorized.catalogDigest ||
      !sameStrings(prepared.services, services)
    ) {
      throw new PreviewSourcePromotionError(
        "artifact-rejected",
        "prepared artifact does not match the authorized preview generation",
        409,
      );
    }

    const result = await this.deps.promotions.promoteSourceBundle({
      executionId: input.executionId,
      fileId: prepared.fileId,
      repo: this.deps.sourceRepository,
      base: this.deps.baseBranch,
      baseRevision: prepared.capturedSourceRevision,
      mode: "pr",
      title: input.title ?? `Preview change (${services.join(", ")})`,
      tier: "tar-overlay-set",
      repoSubdir: "",
      syncPaths: [],
      branchPrefix: "preview-feature",
      branchName,
      draft: input.draft,
      prBody: input.bodyMarkdown ?? undefined,
    });
    if (result.status !== "ok") {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        result.status === "unavailable" ? result.message : result.error,
        502,
      );
    }
    const prUrl = result.prUrl;
    const pullRequestNumber =
      typeof prUrl === "string"
        ? parsePullRequestNumber(prUrl, this.deps.sourceRepository)
        : null;
    if (
      result.branch !== branchName ||
      !FULL_SHA.test(result.commitSha) ||
      result.commitSha === prepared.capturedSourceRevision ||
      result.baseRevision !== prepared.capturedSourceRevision ||
      result.pullRequestBase !== this.deps.baseBranch ||
      typeof prUrl !== "string" ||
      pullRequestNumber === null ||
      !validChangedPaths(result.changedPaths)
    ) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        "promotion runner returned invalid Git or pull-request provenance",
        502,
      );
    }
    const commitSha = result.commitSha as ImmutableGitSha;
    let pullRequest;
    try {
      pullRequest = await this.deps.pullRequests.inspectOpen({
        repository: this.deps.sourceRepository,
        number: pullRequestNumber,
      });
    } catch (cause) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        `GitHub pull request verification failed: ${message(cause)}`,
        409,
      );
    }
    if (
      pullRequest.repository !== this.deps.sourceRepository ||
      pullRequest.number !== pullRequestNumber ||
      pullRequest.baseSha !== prepared.capturedSourceRevision ||
      pullRequest.headRef !== branchName ||
      pullRequest.headSha !== commitSha
    ) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        "GitHub pull request does not match the promoted branch",
        409,
      );
    }
    if (
      !(await this.deps.git.verifyBranch({
        repository: this.deps.sourceRepository,
        branch: result.branch,
        commitSha,
        baseBranch: this.deps.baseBranch,
        baseRevision: prepared.capturedSourceRevision as ImmutableGitSha,
        expectedChangedPaths: result.changedPaths,
      }))
    ) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        "GitHub branch does not match the promoted artifact",
        409,
      );
    }
    const changed = this.deps.catalog.deriveChangedServices(
      result.changedPaths,
    );
    if (changed.unmappedRuntimePaths.length > 0) {
      throw new PreviewSourcePromotionError(
        "artifact-rejected",
        `promotion changed unmapped runtime paths: ${changed.unmappedRuntimePaths.join(", ")}`,
        409,
      );
    }
    const affected = this.deps.catalog.assertPreviewNativeServices(
      changed.services,
    );
    const uncaptured = affected.filter(
      (service) => !services.includes(service),
    );
    if (uncaptured.length > 0) {
      throw new PreviewSourcePromotionError(
        "artifact-rejected",
        `promotion changed services without captured overlays: ${uncaptured.join(", ")}`,
        409,
      );
    }
    return Object.freeze({
      ok: true,
      previewName: input.previewName,
      requestId: input.environmentRequestId,
      executionId: input.executionId,
      artifactId: input.artifactId,
      services: Object.freeze([...affected]),
      branch: result.branch,
      commitSha,
      prUrl,
      pullRequest: Object.freeze({
        repository: pullRequest.repository,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      }),
      draft: input.draft,
    });
  }
}

function validateLocalInput(input: {
  executionId: string;
  artifactId: string;
  title?: string | null;
  bodyMarkdown?: string | null;
}): void {
  if (!SAFE_ID.test(input.executionId) || !SAFE_ID.test(input.artifactId)) {
    throw new PreviewSourcePromotionError(
      "invalid-request",
      "source promotion execution or artifact id is invalid",
      400,
    );
  }
  validateText(input.title, MAX_TITLE, "title");
  validateText(input.bodyMarkdown, MAX_BODY, "bodyMarkdown");
}

function validateBrokerInput(input: PreviewSourcePromotionBrokerRequest): void {
  validateLocalInput(input);
  if (
    !SAFE_ID.test(input.operationId) ||
    input.operationId !== input.artifactId ||
    !PREVIEW_NAME.test(input.previewName) ||
    !FULL_SHA.test(input.environmentPlatformRevision) ||
    !FULL_SHA.test(input.environmentSourceRevision) ||
    !SHA256.test(input.catalogDigest) ||
    !SHA256.test(input.artifactIdentity.fileDigest) ||
    input.artifactIdentity.previewName !== input.previewName ||
    input.artifactIdentity.requestId !== input.environmentRequestId ||
    input.artifactIdentity.executionId !== input.executionId ||
    input.artifactIdentity.platformRevision !==
      input.environmentPlatformRevision ||
    input.artifactIdentity.sourceRevision !== input.environmentSourceRevision ||
    input.artifactIdentity.catalogDigest !== input.catalogDigest
  ) {
    throw new PreviewSourcePromotionError(
      "invalid-request",
      "source promotion immutable identity is invalid",
      400,
    );
  }
}

function sourcePromotionBranch(operationId: string): string {
  const branch = `preview-feature-${operationId}`;
  if (
    !SAFE_BRANCH.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock")
  ) {
    throw new PreviewSourcePromotionError(
      "invalid-request",
      "source promotion operation cannot form a safe branch",
      400,
    );
  }
  return branch;
}

function sameArtifactIdentity(
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

function validateText(
  value: string | null | undefined,
  max: number,
  field: string,
): void {
  if (value !== undefined && value !== null) {
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new PreviewSourcePromotionError(
        "invalid-request",
        `source promotion ${field} is invalid`,
        400,
      );
    }
  }
}

function cleanOptional(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validChangedPaths(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 1024 &&
        !path.startsWith("/") &&
        !path.split("/").includes(".."),
    )
  );
}

function parsePullRequestNumber(
  value: string,
  repository: string,
): number | null {
  try {
    const url = new URL(value);
    const match = new RegExp(
      `^/${escapeRegex(repository)}/pull/([1-9][0-9]*)$`,
    ).exec(url.pathname);
    if (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      match &&
      !url.search &&
      !url.hash
    ) {
      const number = Number(match[1]);
      return Number.isSafeInteger(number) ? number : null;
    }
    return null;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
