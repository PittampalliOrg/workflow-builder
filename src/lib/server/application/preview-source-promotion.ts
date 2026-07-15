import { createHash } from "node:crypto";
import { PreviewSourcePromotionExclusivityBusyError } from "$lib/server/application/ports";
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
  PreviewSourcePromotionExclusivityPort,
  PreviewSourcePromotionPort,
  PreviewSourcePromotionReceipt,
  PreviewSourcePromotionReceiptScope,
  PreviewSourcePromotionReceiptStorePort,
  PreviewSourcePromotionResult,
  SourceBundlePromotionRunnerPort,
} from "$lib/server/application/ports";
import { isPreviewResourceId } from "$lib/server/application/preview-resource-id";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SAFE_COORDINATE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
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
      | "promotion-busy"
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
      draft: true,
    });
  }
}

type BrokerDeps = Readonly<{
  authority: PreviewControlSourceAuthorityPort;
  trust: PreviewAcceptancePromotionPreparationPort;
  promotions: SourceBundlePromotionRunnerPort;
  git: PreviewControlGitSourceVerificationPort;
  pullRequests: PreviewControlPullRequestInspectionPort;
  receipts: PreviewSourcePromotionReceiptStorePort;
  exclusivity: PreviewSourcePromotionExclusivityPort;
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
    const receiptScope = sourcePromotionReceiptScope(input, this.deps);
    try {
      return await this.deps.exclusivity.runExclusive(receiptScope, () =>
        this.promoteExclusive(input, receiptScope),
      );
    } catch (cause) {
      if (cause instanceof PreviewSourcePromotionExclusivityBusyError) {
        throw new PreviewSourcePromotionError(
          "promotion-busy",
          cause.message,
          409,
        );
      }
      throw cause;
    }
  }

  private async promoteExclusive(
    input: PreviewSourcePromotionBrokerRequest,
    receiptScope: PreviewSourcePromotionReceiptScope,
  ): Promise<Awaited<ReturnType<PreviewSourcePromotionBrokerPort["promote"]>>> {
    const services = this.deps.catalog.assertPreviewNativeServices(
      input.artifactIdentity.services,
    );
    const branchName = previewSourcePromotionBranch(receiptScope);
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
      !isPreviewResourceId(prepared.fileId) ||
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

    const replay = await this.deps.receipts.getByArtifact(input.artifactId);
    if (replay) {
      assertReceiptScope(replay, receiptScope, input.artifactId, branchName);
      await verifyStoredReceipt(this.deps, replay);
      return promotionResult(replay);
    }
    const latest =
      await this.deps.receipts.getLatestForExecution(receiptScope);
    if (latest) {
      assertReceiptScope(latest, receiptScope, null, branchName);
      await verifyLeaseReceipt(this.deps, latest);
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
      branchLease: {
        expectedHeadSha: latest?.commitSha ?? null,
        ...(latest
          ? { existingPullRequestNumber: latest.pullRequestNumber }
          : {}),
      },
      draft: true,
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
      (latest !== null && pullRequest.number !== latest.pullRequestNumber) ||
      pullRequest.draft !== true ||
      !FULL_SHA.test(pullRequest.baseSha) ||
      pullRequest.baseSha === commitSha ||
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
        expectedBaseSnapshot: pullRequest.baseSha,
        expectedChangedPaths: result.changedPaths,
      }))
    ) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        "GitHub branch does not match the promoted artifact",
        409,
      );
    }
    // Bind the receipt to the exact base/head tuple whose ancestry was verified.
    // A target-branch move must retry the whole promotion instead of recording
    // an unverified newer base in an immutable receipt.
    try {
      pullRequest = await this.deps.pullRequests.inspect({
        repository: this.deps.sourceRepository,
        number: pullRequestNumber,
        baseSha: pullRequest.baseSha,
        headSha: commitSha,
      });
    } catch (cause) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        `GitHub pull request post-verification failed: ${message(cause)}`,
        409,
      );
    }
    if (
      pullRequest.repository !== this.deps.sourceRepository ||
      pullRequest.number !== pullRequestNumber ||
      (latest !== null && pullRequest.number !== latest.pullRequestNumber) ||
      pullRequest.draft !== true ||
      !FULL_SHA.test(pullRequest.baseSha) ||
      pullRequest.baseSha === commitSha ||
      pullRequest.headRef !== branchName ||
      pullRequest.headSha !== commitSha
    ) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        "GitHub pull request changed after branch verification",
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
    let receipt;
    try {
      receipt = await this.deps.receipts.put({
        artifactId: input.artifactId,
        previewName: input.previewName,
        requestId: input.environmentRequestId,
        executionId: input.executionId,
        platformRevision: authorized.platformRevision,
        sourceRevision: authorized.sourceRevision,
        catalogDigest: authorized.catalogDigest,
        repository: this.deps.sourceRepository,
        baseBranch: this.deps.baseBranch,
        baseSha: pullRequest.baseSha,
        branch: result.branch,
        commitSha,
        prUrl,
        pullRequestNumber: pullRequest.number,
        draft: true,
        services: affected,
        changedPaths: result.changedPaths,
      });
    } catch (cause) {
      throw new PreviewSourcePromotionError(
        "materialization-failed",
        `source promotion receipt could not be persisted: ${message(cause)}`,
        502,
      );
    }
    return promotionResult(receipt);
  }
}

function validateLocalInput(input: {
  executionId: string;
  artifactId: string;
  title?: string | null;
  bodyMarkdown?: string | null;
}): void {
  if (
    !isPreviewResourceId(input.executionId) ||
    !SAFE_COORDINATE.test(input.artifactId)
  ) {
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
    !SAFE_COORDINATE.test(input.operationId) ||
    input.operationId !== input.artifactId ||
    input.draft !== true ||
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

function sourcePromotionReceiptScope(
  input: PreviewSourcePromotionBrokerRequest,
  deps: Pick<BrokerDeps, "sourceRepository" | "baseBranch">,
): PreviewSourcePromotionReceiptScope {
  return Object.freeze({
    previewName: input.previewName,
    requestId: input.environmentRequestId,
    executionId: input.executionId,
    platformRevision: input.environmentPlatformRevision as ImmutableGitSha,
    sourceRevision: input.environmentSourceRevision as ImmutableGitSha,
    catalogDigest: input.catalogDigest,
    repository: deps.sourceRepository,
    baseBranch: deps.baseBranch,
  });
}

export function previewSourcePromotionBranch(
  scope: PreviewSourcePromotionReceiptScope,
): string {
  const digest = createHash("sha256")
    .update(
      [
        scope.previewName,
        scope.requestId,
        scope.executionId,
        scope.platformRevision,
        scope.sourceRevision,
        scope.catalogDigest,
        scope.repository,
        scope.baseBranch,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  const branch = `preview-feature-${digest}`;
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

function assertReceiptScope(
  receipt: PreviewSourcePromotionReceipt,
  scope: PreviewSourcePromotionReceiptScope,
  artifactId: string | null,
  branch: string,
): void {
  if (
    (artifactId !== null && receipt.artifactId !== artifactId) ||
    receipt.previewName !== scope.previewName ||
    receipt.requestId !== scope.requestId ||
    receipt.executionId !== scope.executionId ||
    receipt.platformRevision !== scope.platformRevision ||
    receipt.sourceRevision !== scope.sourceRevision ||
    receipt.catalogDigest !== scope.catalogDigest ||
    receipt.repository !== scope.repository ||
    receipt.baseBranch !== scope.baseBranch ||
    !FULL_SHA.test(receipt.baseSha) ||
    receipt.baseSha === receipt.commitSha ||
    receipt.branch !== branch ||
    receipt.draft !== true ||
    !validChangedPaths(receipt.changedPaths)
  ) {
    throw new PreviewSourcePromotionError(
      "authority-mismatch",
      "stored source promotion receipt is outside the authorized preview session",
      409,
    );
  }
}

async function verifyStoredReceipt(
  deps: Pick<BrokerDeps, "git" | "pullRequests" | "sourceRepository" | "baseBranch">,
  receipt: PreviewSourcePromotionReceipt,
): Promise<void> {
  let pullRequest;
  try {
    pullRequest = await deps.pullRequests.inspectOpen({
      repository: deps.sourceRepository,
      number: receipt.pullRequestNumber,
    });
  } catch (cause) {
    throw new PreviewSourcePromotionError(
      "materialization-failed",
      `stored draft pull request is unavailable: ${message(cause)}`,
      409,
    );
  }
  if (
    pullRequest.repository !== receipt.repository ||
    pullRequest.number !== receipt.pullRequestNumber ||
    pullRequest.draft !== true ||
    !FULL_SHA.test(pullRequest.baseSha) ||
    pullRequest.baseSha === receipt.commitSha ||
    pullRequest.headRef !== receipt.branch ||
    pullRequest.headSha !== receipt.commitSha ||
    !(await deps.git.verifyBranch({
      repository: receipt.repository,
      branch: receipt.branch,
      commitSha: receipt.commitSha,
      baseBranch: receipt.baseBranch,
      baseRevision: receipt.sourceRevision,
      expectedBaseSnapshot: pullRequest.baseSha,
      expectedChangedPaths: receipt.changedPaths,
    }))
  ) {
    throw new PreviewSourcePromotionError(
      "materialization-failed",
      "stored source promotion receipt no longer matches GitHub",
      409,
    );
  }
}

/**
 * Verify the draft PR identity before a leased update. A different live head is
 * allowed through only so the runner can recover a deterministic candidate
 * pushed before its receipt write failed; force-with-lease and post-push GitHub
 * verification remain authoritative for that recovery.
 */
async function verifyLeaseReceipt(
  deps: Pick<BrokerDeps, "git" | "pullRequests" | "sourceRepository" | "baseBranch">,
  receipt: PreviewSourcePromotionReceipt,
): Promise<void> {
  let pullRequest;
  try {
    pullRequest = await deps.pullRequests.inspectOpen({
      repository: deps.sourceRepository,
      number: receipt.pullRequestNumber,
    });
  } catch (cause) {
    throw new PreviewSourcePromotionError(
      "materialization-failed",
      `stored draft pull request is unavailable: ${message(cause)}`,
      409,
    );
  }
  if (
    pullRequest.repository !== receipt.repository ||
    pullRequest.number !== receipt.pullRequestNumber ||
    pullRequest.draft !== true ||
    !FULL_SHA.test(pullRequest.baseSha) ||
    pullRequest.baseSha === pullRequest.headSha ||
    pullRequest.headRef !== receipt.branch
  ) {
    throw new PreviewSourcePromotionError(
      "materialization-failed",
      "stored source promotion lease no longer matches its draft pull request",
      409,
    );
  }
  if (
    pullRequest.headSha === receipt.commitSha &&
    !(await deps.git.verifyBranch({
      repository: receipt.repository,
      branch: receipt.branch,
      commitSha: receipt.commitSha,
      baseBranch: receipt.baseBranch,
      baseRevision: receipt.sourceRevision,
      expectedBaseSnapshot: pullRequest.baseSha,
      expectedChangedPaths: receipt.changedPaths,
    }))
  ) {
    throw new PreviewSourcePromotionError(
      "materialization-failed",
      "stored source promotion lease no longer matches GitHub",
      409,
    );
  }
}

function promotionResult(
  receipt: PreviewSourcePromotionReceipt,
): PreviewSourcePromotionResult {
  return Object.freeze({
    ok: true,
    receiptId: receipt.receiptId,
    previewName: receipt.previewName,
    requestId: receipt.requestId,
    executionId: receipt.executionId,
    artifactId: receipt.artifactId,
    services: Object.freeze([...receipt.services]),
    branch: receipt.branch,
    commitSha: receipt.commitSha,
    prUrl: receipt.prUrl,
    pullRequest: Object.freeze({
      repository: receipt.repository,
      number: receipt.pullRequestNumber,
      baseSha: receipt.baseSha,
      headSha: receipt.commitSha,
    }),
    draft: true,
  });
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
