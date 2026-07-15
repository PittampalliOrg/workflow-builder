import type {
  PreviewAcceptanceBrokerPort,
  PreviewAcceptanceBrokerRequest,
  PreviewAcceptanceBrokerResult,
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptanceCommitStatusPort,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptStorePort,
  PreviewControlPullRequest,
  PreviewControlPullRequestInspectionPort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlSourceAuthorityPort,
  PreviewGateReconcilerPort,
} from "$lib/server/application/ports";
import { assertPreviewAcceptedImageReceiptRequirement } from "$lib/server/application/preview-accepted-images";
import { previewGateRequirementDigest } from "$lib/server/application/preview-gate-requirements";
import type {
  PreviewEnvironmentAcceptanceInput,
  PreviewEnvironmentAcceptanceOutcome,
} from "$lib/server/application/preview-environment-acceptance";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export class PreviewAcceptanceBrokerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewAcceptanceBrokerInputError";
  }
}

type AcceptanceReplay = Readonly<{
  replay(
    input: PreviewEnvironmentAcceptanceInput,
  ): Promise<PreviewEnvironmentAcceptanceOutcome>;
}>;

type PreviewAcceptanceBrokerDeps = Readonly<{
  authority: PreviewControlSourceAuthorityPort;
  pullRequests: PreviewControlPullRequestInspectionPort;
  git: PreviewControlGitSourceVerificationPort;
  catalog: PreviewAcceptanceChangedServiceCatalogPort;
  acceptance: AcceptanceReplay;
  statuses: PreviewAcceptanceCommitStatusPort;
  receipts: PreviewAcceptedImageReceiptStorePort;
  receiptAttestations: PreviewAcceptedImageReceiptAttestationPort;
  gate: PreviewGateReconcilerPort;
  sourceRepository: string;
  baseBranch: string;
  now?: () => Date;
  ttlHours?: number;
  timeoutMs?: number;
}>;

/** Physical-only acceptance orchestration. Mutable preview BFFs hold no build or cluster authority. */
export class ApplicationPreviewAcceptanceBrokerService implements PreviewAcceptanceBrokerPort {
  constructor(private readonly deps: PreviewAcceptanceBrokerDeps) {}

  async replay(
    input: PreviewAcceptanceBrokerRequest,
  ): Promise<PreviewAcceptanceBrokerResult> {
    this.validate(input);
    const pullRequest = await this.deps.pullRequests.inspect({
      repository: this.deps.sourceRepository,
      number: input.pullRequest.number,
      baseSha: input.pullRequest.baseSha,
      headSha: input.pullRequest.headSha,
    });
    const changed = this.deps.catalog.deriveChangedServices(
      pullRequest.changedPaths,
    );
    if (changed.unmappedRuntimePaths.length > 0) {
      throw new PreviewAcceptanceBrokerInputError(
        `pull request changes unmapped runtime paths: ${changed.unmappedRuntimePaths.join(", ")}`,
      );
    }
    if (changed.services.length === 0) {
      throw new PreviewAcceptanceBrokerInputError(
        "pull request does not change a catalog-backed runtime service",
      );
    }
    const source = await this.deps.authority.authorize({
      previewName: input.previewName,
      environmentRequestId: input.environmentRequestId!,
      environmentPlatformRevision: input.environmentPlatformRevision!,
      environmentSourceRevision: input.environmentSourceRevision!,
      catalogDigest: input.catalogDigest!,
      requiredServices: changed.services,
    });
    if (
      source.previewName !== input.previewName ||
      source.requestId !== input.environmentRequestId ||
      source.platformRevision !== input.environmentPlatformRevision ||
      source.sourceRevision !== input.environmentSourceRevision ||
      source.catalogDigest !== input.catalogDigest ||
      !sameStrings(source.services, changed.services)
    ) {
      throw new PreviewAcceptanceBrokerInputError(
        "physical source authority returned a different preview identity",
      );
    }
    const verifiedBranch = await this.deps.git.verifyBranch({
      repository: pullRequest.repository,
      branch: pullRequest.headRef,
      commitSha: pullRequest.headSha,
      baseBranch: this.deps.baseBranch,
      baseRevision: source.sourceRevision,
      expectedBaseHead: pullRequest.baseSha,
      expectedChangedPaths: pullRequest.changedPaths,
    });
    if (!verifiedBranch) {
      throw new PreviewAcceptanceBrokerInputError(
        "pull request branch does not descend from the authorized preview source baseline",
      );
    }
    if (source.catalogDigest !== this.deps.catalog.currentDigest()) {
      throw new PreviewAcceptanceBrokerInputError(
        "authorized preview catalog is not current",
      );
    }
    const requirementDigest = previewGateRequirementDigest(
      source.catalogDigest,
      "preview/immutable-acceptance",
      changed.services,
    );
    const existingReceipt = await this.deps.receipts.getByRepoPrHeadContext({
      repository: pullRequest.repository,
      pullRequestNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      context: "preview/immutable-acceptance",
    });
    if (existingReceipt) {
      assertPreviewAcceptedImageReceiptRequirement(
        existingReceipt,
        {
          repository: pullRequest.repository,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          catalogDigest: source.catalogDigest,
          context: "preview/immutable-acceptance",
          subjects: changed.services,
        },
        this.deps.receiptAttestations,
      );
      const resumed: PreviewAcceptanceBrokerResult = Object.freeze({
        ok: true,
        name: acceptanceName(pullRequest.number, pullRequest.headSha),
        previewName: input.previewName,
        pullRequest: Object.freeze({
          repository: pullRequest.repository,
          number: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
        }),
        services: Object.freeze([...changed.services]),
        images: Object.freeze(
          existingReceipt.subjects.map((image) =>
            Object.freeze({
              service: image.subject,
              sourceRevision: image.sourceRevision,
              buildId: image.buildRun,
              imageRef: image.imageRef,
              digest: image.digest,
              immutableRef: image.immutableRef,
            }),
          ),
        ),
        evidenceReceiptDigest: existingReceipt.receiptDigest,
      });
      try {
        await this.publishAcceptanceStatus(
          pullRequest,
          "success",
          `Immutable preview acceptance passed for ${changed.services.length} service${changed.services.length === 1 ? "" : "s"}`,
          requirementDigest,
          existingReceipt.receiptDigest,
        );
        await this.reconcileGate(pullRequest);
        return resumed;
      } catch (cause) {
        return Object.freeze({
          ...resumed,
          ok: false,
          stage: "reporting",
          message: `accepted evidence could not be republished to the verified PR head: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }

    await this.publishAcceptanceStatus(
      pullRequest,
      "pending",
      `Building immutable images for ${changed.services.length} service${changed.services.length === 1 ? "" : "s"}`,
      requirementDigest,
    );
    await this.reconcileGate(pullRequest);

    const name = acceptanceName(pullRequest.number, pullRequest.headSha);
    let outcome: PreviewEnvironmentAcceptanceOutcome;
    let evidenceReceiptDigest: `sha256:${string}` | undefined;
    try {
      outcome = await this.deps.acceptance.replay({
        name,
        platformRevision: source.platformRevision,
        sourceRevision: pullRequest.headSha,
        services: changed.services,
        owner: { kind: "user", id: source.owner },
        origin: {
          kind: "pull-request",
          reference: `${pullRequest.repository}#${pullRequest.number}`,
        },
        ttlHours: this.deps.ttlHours ?? 4,
        lifecycle: "ephemeral",
        provenance: {
          requestId: input.requestId,
          requestedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
          platformRepository: "PittampalliOrg/stacks",
          sourceRepository: this.deps.sourceRepository,
          parentEnvironmentId: input.previewName,
        },
        timeoutMs: this.deps.timeoutMs ?? 20 * 60_000,
      });
      if (outcome.ok) {
        const receipt = await this.deps.receipts.put({
          repository: pullRequest.repository,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          catalogDigest: source.catalogDigest,
          context: "preview/immutable-acceptance",
          subjects: (outcome.images ?? []).map((image) => ({
            subject: image.service,
            sourceRevision: image.sourceRevision,
            buildRun: image.buildId,
            imageRef: image.imageRef,
            digest: image.digest,
            immutableRef: image.immutableRef,
          })),
        });
        assertPreviewAcceptedImageReceiptRequirement(
          receipt,
          {
            repository: pullRequest.repository,
            pullRequestNumber: pullRequest.number,
            baseSha: pullRequest.baseSha,
            headSha: pullRequest.headSha,
            catalogDigest: source.catalogDigest,
            context: "preview/immutable-acceptance",
            subjects: changed.services,
          },
          this.deps.receiptAttestations,
        );
        evidenceReceiptDigest = receipt.receiptDigest;
      }
    } catch (cause) {
      try {
        await this.publishAcceptanceStatus(
          pullRequest,
          "error",
          "Immutable preview acceptance could not complete",
          requirementDigest,
        );
        await this.reconcileGate(pullRequest);
      } catch (reportingCause) {
        throw new Error(
          `${cause instanceof Error ? cause.message : String(cause)}; exact-head reporting failed: ${reportingCause instanceof Error ? reportingCause.message : String(reportingCause)}`,
          { cause },
        );
      }
      throw cause;
    }
    const result: PreviewAcceptanceBrokerResult = Object.freeze({
      ok: outcome.ok,
      name,
      previewName: input.previewName,
      pullRequest: Object.freeze({
        repository: pullRequest.repository,
        number: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      }),
      services: Object.freeze([...changed.services]),
      ...(outcome.images ? { images: outcome.images } : {}),
      ...(outcome.verification ? { verification: outcome.verification } : {}),
      ...("cleanup" in outcome ? { cleanup: outcome.cleanup ?? null } : {}),
      ...(evidenceReceiptDigest ? { evidenceReceiptDigest } : {}),
      ...(!outcome.ok
        ? { stage: outcome.stage, message: outcome.message }
        : {}),
    });
    try {
      await this.publishAcceptanceStatus(
        pullRequest,
        outcome.ok ? "success" : "failure",
        outcome.ok
          ? `Immutable preview acceptance passed for ${changed.services.length} service${changed.services.length === 1 ? "" : "s"}`
          : `Immutable preview acceptance failed at ${outcome.stage}`,
        requirementDigest,
        evidenceReceiptDigest,
      );
      await this.reconcileGate(pullRequest);
    } catch (cause) {
      return Object.freeze({
        ...result,
        ok: false,
        stage: "reporting",
        message: `acceptance result could not be published to the verified PR head: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    return result;
  }

  private async publishAcceptanceStatus(
    pullRequest: PreviewControlPullRequest,
    state: "pending" | "success" | "failure" | "error",
    acceptanceDescription: string,
    requirementDigest: `sha256:${string}`,
    evidenceReceiptDigest?: `sha256:${string}`,
  ): Promise<void> {
    // Re-read immediately before every subordinate publication. A synchronize
    // event must leave the old head unfinalized.
    await this.deps.pullRequests.inspect({
      repository: pullRequest.repository,
      number: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    });
    const identity = Object.freeze({
      repository: pullRequest.repository,
      pullRequestNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    });
    await this.deps.statuses.publish({
      ...identity,
      context: "preview/immutable-acceptance",
      state,
      description: acceptanceDescription,
      requirementDigest,
      ...(state === "success" && evidenceReceiptDigest
        ? { evidenceReceiptDigest }
        : {}),
    });
  }

  private reconcileGate(pullRequest: PreviewControlPullRequest): Promise<void> {
    return this.deps.gate.reconcile({
      repository: pullRequest.repository,
      number: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    });
  }

  private validate(input: PreviewAcceptanceBrokerRequest): void {
    if (!REQUEST_ID.test(input.requestId))
      throw new PreviewAcceptanceBrokerInputError("requestId is invalid");
    if (!PREVIEW_NAME.test(input.previewName))
      throw new PreviewAcceptanceBrokerInputError("previewName is invalid");
    if (
      !REQUEST_ID.test(input.environmentRequestId ?? "") ||
      !FULL_SHA.test(input.environmentPlatformRevision ?? "") ||
      !FULL_SHA.test(input.environmentSourceRevision ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(input.catalogDigest ?? "")
    ) {
      throw new PreviewAcceptanceBrokerInputError(
        "preview environment capability identity is invalid",
      );
    }
    if (input.pullRequest.repository !== this.deps.sourceRepository)
      throw new PreviewAcceptanceBrokerInputError(
        `acceptance is restricted to ${this.deps.sourceRepository}`,
      );
    if (
      !Number.isSafeInteger(input.pullRequest.number) ||
      input.pullRequest.number < 1
    )
      throw new PreviewAcceptanceBrokerInputError(
        "pull request number is invalid",
      );
    if (
      !FULL_SHA.test(input.pullRequest.baseSha) ||
      !FULL_SHA.test(input.pullRequest.headSha) ||
      input.pullRequest.baseSha === input.pullRequest.headSha
    ) {
      throw new PreviewAcceptanceBrokerInputError(
        "pull request requires distinct full lowercase base and head SHAs",
      );
    }
  }
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

function acceptanceName(number: number, headSha: string): string {
  return `accept-pr${number}-${headSha.slice(0, 12)}`.slice(0, 40);
}
