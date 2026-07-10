import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptanceCommitStatusPort,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptStorePort,
  PreviewActivationArtifact,
  PreviewActivationGatePort,
  PreviewActivationGateRequest,
  PreviewActivationGateResult,
  PreviewActivationImageBuildPort,
  PreviewControlPullRequest,
  PreviewControlPullRequestInspectionPort,
  PreviewGateReconcilerPort,
} from "$lib/server/application/ports";
import { assertPreviewAcceptedImageReceiptRequirement } from "$lib/server/application/preview-accepted-images";
import { previewGateRequirementDigest } from "$lib/server/application/preview-gate-requirements";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SUPPORTED_ARTIFACTS = new Set<PreviewActivationArtifact>([
  "dev-sync-sidecar",
]);

export class PreviewActivationGateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewActivationGateInputError";
  }
}

type PreviewActivationGateDeps = Readonly<{
  pullRequests: PreviewControlPullRequestInspectionPort;
  catalog: PreviewAcceptanceChangedServiceCatalogPort;
  builds: PreviewActivationImageBuildPort;
  statuses: PreviewAcceptanceCommitStatusPort;
  receipts: PreviewAcceptedImageReceiptStorePort;
  receiptAttestations: PreviewAcceptedImageReceiptAttestationPort;
  gate: PreviewGateReconcilerPort;
  sourceRepository: string;
}>;

/** Coordinates exact-head activation builds without exposing build or status authority. */
export class ApplicationPreviewActivationGateService implements PreviewActivationGatePort {
  constructor(private readonly deps: PreviewActivationGateDeps) {}

  async buildAndFinalize(
    input: PreviewActivationGateRequest,
  ): Promise<PreviewActivationGateResult> {
    this.validate(input);
    const pullRequest = await this.deps.pullRequests.inspect({
      repository: this.deps.sourceRepository,
      number: input.pullRequest.number,
      baseSha: input.pullRequest.baseSha,
      headSha: input.pullRequest.headSha,
    });
    if (input.catalogDigest !== this.deps.catalog.currentDigest()) {
      throw new PreviewActivationGateInputError("catalogDigest is not current");
    }
    const changed = this.deps.catalog.deriveChangedServices(
      pullRequest.changedPaths,
    );
    if (changed.unmappedRuntimePaths.length > 0) {
      throw new PreviewActivationGateInputError(
        `pull request changes unmapped runtime paths: ${changed.unmappedRuntimePaths.join(", ")}`,
      );
    }
    if (changed.activationArtifacts.length === 0) {
      throw new PreviewActivationGateInputError(
        "pull request does not require activation-image evidence",
      );
    }
    const artifacts = changed.activationArtifacts.map((artifact) => {
      if (!SUPPORTED_ARTIFACTS.has(artifact as PreviewActivationArtifact)) {
        throw new PreviewActivationGateInputError(
          `unsupported activation artifact: ${artifact}`,
        );
      }
      return artifact as PreviewActivationArtifact;
    });
    const requirementDigest = previewGateRequirementDigest(
      input.catalogDigest,
      "preview/activation-images",
      artifacts,
    );
    const existingReceipt = await this.deps.receipts.getByRepoPrHeadContext({
      repository: pullRequest.repository,
      pullRequestNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      context: "preview/activation-images",
    });
    if (existingReceipt) {
      assertPreviewAcceptedImageReceiptRequirement(
        existingReceipt,
        {
          repository: pullRequest.repository,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          catalogDigest: input.catalogDigest,
          context: "preview/activation-images",
          subjects: artifacts,
        },
        this.deps.receiptAttestations,
      );
      const images = Object.freeze(
        existingReceipt.subjects.map((image) =>
          Object.freeze({
            artifact: image.subject as PreviewActivationArtifact,
            sourceRevision: image.sourceRevision,
            pipelineRun: image.buildRun,
            imageRef: image.imageRef,
            digest: image.digest,
            immutableRef: image.immutableRef,
          }),
        ),
      );
      await this.publish(
        pullRequest,
        "success",
        `Activation images passed for ${images.length} artifact${images.length === 1 ? "" : "s"}`,
        requirementDigest,
        existingReceipt.receiptDigest,
      );
      await this.deps.gate.reconcile(pullRequest);
      return Object.freeze({
        ok: true,
        pullRequest: Object.freeze({
          repository: pullRequest.repository,
          number: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
        }),
        catalogDigest: input.catalogDigest,
        evidenceReceiptDigest: existingReceipt.receiptDigest,
        images,
      });
    }

    await this.publish(
      pullRequest,
      "pending",
      `Building ${artifacts.length} activation image${artifacts.length === 1 ? "" : "s"}`,
      requirementDigest,
    );
    await this.deps.gate.reconcile(pullRequest);

    try {
      const images = await Promise.all(
        artifacts.map((artifact) =>
          this.deps.builds.build({
            requestId: activationRequestId(
              input.requestId,
              pullRequest,
              artifact,
            ),
            artifact,
            sourceRepository: "PittampalliOrg/workflow-builder",
            sourceRevision: pullRequest.headSha,
            catalogDigest: input.catalogDigest,
          }),
        ),
      );
      const receipt = await this.deps.receipts.put({
        repository: pullRequest.repository,
        pullRequestNumber: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        catalogDigest: input.catalogDigest,
        context: "preview/activation-images",
        subjects: images.map((image) => ({
          subject: image.artifact,
          sourceRevision: image.sourceRevision,
          buildRun: image.pipelineRun,
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
          catalogDigest: input.catalogDigest,
          context: "preview/activation-images",
          subjects: artifacts,
        },
        this.deps.receiptAttestations,
      );
      await this.publish(
        pullRequest,
        "success",
        `Activation images passed for ${images.length} artifact${images.length === 1 ? "" : "s"}`,
        requirementDigest,
        receipt.receiptDigest,
      );
      await this.deps.gate.reconcile(pullRequest);
      return Object.freeze({
        ok: true,
        pullRequest: Object.freeze({
          repository: pullRequest.repository,
          number: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
        }),
        catalogDigest: input.catalogDigest,
        evidenceReceiptDigest: receipt.receiptDigest,
        images: Object.freeze(images),
      });
    } catch (cause) {
      try {
        await this.publish(
          pullRequest,
          "error",
          "Activation image build could not complete",
          requirementDigest,
        );
        await this.deps.gate.reconcile(pullRequest);
      } catch (reportingCause) {
        throw new Error(
          `${message(cause)}; exact-head reporting failed: ${message(reportingCause)}`,
          { cause },
        );
      }
      throw cause;
    }
  }

  private validate(input: PreviewActivationGateRequest): void {
    if (!REQUEST_ID.test(input.requestId)) {
      throw new PreviewActivationGateInputError("requestId is invalid");
    }
    if (
      input.pullRequest.repository !== this.deps.sourceRepository ||
      !Number.isSafeInteger(input.pullRequest.number) ||
      input.pullRequest.number < 1 ||
      !FULL_SHA.test(input.pullRequest.baseSha) ||
      !FULL_SHA.test(input.pullRequest.headSha) ||
      input.pullRequest.baseSha === input.pullRequest.headSha
    ) {
      throw new PreviewActivationGateInputError(
        "pull request tuple is invalid",
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(input.catalogDigest)) {
      throw new PreviewActivationGateInputError("catalogDigest is invalid");
    }
  }

  private async publish(
    pullRequest: PreviewControlPullRequest,
    state: "pending" | "success" | "error",
    description: string,
    requirementDigest: `sha256:${string}`,
    evidenceReceiptDigest?: `sha256:${string}`,
  ): Promise<void> {
    await this.deps.pullRequests.inspect({
      repository: pullRequest.repository,
      number: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
    });
    await this.deps.statuses.publish({
      repository: pullRequest.repository,
      pullRequestNumber: pullRequest.number,
      baseSha: pullRequest.baseSha,
      headSha: pullRequest.headSha,
      context: "preview/activation-images",
      state,
      description,
      requirementDigest,
      ...(state === "success" && evidenceReceiptDigest
        ? { evidenceReceiptDigest }
        : {}),
    });
  }
}

function activationRequestId(
  requestId: string,
  pullRequest: PreviewControlPullRequest,
  artifact: PreviewActivationArtifact,
): string {
  return [
    "activation",
    pullRequest.number,
    pullRequest.headSha.slice(0, 12),
    artifact,
    requestId,
  ].join(":");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
