import type {
  PreviewAcceptanceCommitStatus,
  PreviewAcceptanceCommitStatusPort,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptStorePort,
  PreviewControlPullRequestInspectionPort,
  PreviewGateBaseCatalogPort,
  PreviewGateReconcilerPort,
  PreviewGateRequirementCatalogPort,
  PreviewGateRequirements,
  PreviewGateSubordinateContext,
} from "$lib/server/application/ports";
import { assertPreviewAcceptedImageReceiptRequirement } from "$lib/server/application/preview-accepted-images";
import { derivePreviewGateRequirementsFromSnapshot } from "$lib/server/application/preview-gate-requirements";

type PreviewGateReconcilerDeps = Readonly<{
  pullRequests: PreviewControlPullRequestInspectionPort;
  catalog: PreviewGateRequirementCatalogPort;
  baseCatalog: PreviewGateBaseCatalogPort;
  receipts: PreviewAcceptedImageReceiptStorePort;
  receiptAttestations: PreviewAcceptedImageReceiptAttestationPort;
  statuses: PreviewAcceptanceCommitStatusPort;
}>;

/** Recomputes the aggregate from exact-head evidence; no subordinate can bypass another. */
export class ApplicationPreviewGateReconcilerService implements PreviewGateReconcilerPort {
  constructor(private readonly deps: PreviewGateReconcilerDeps) {}

  async reconcile(input: {
    repository: string;
    number: number;
    baseSha: string;
    headSha: string;
  }): Promise<void> {
    const pullRequest = await this.deps.pullRequests.inspect(input as never);
    let catalogError: Error | null = null;
    let requirements: PreviewGateRequirements | null = null;
    try {
      const snapshot = await this.deps.baseCatalog.loadAt({
        repository: pullRequest.repository,
        baseSha: pullRequest.baseSha,
      });
      const baseRequirements = derivePreviewGateRequirementsFromSnapshot(
        snapshot,
        pullRequest.changedPaths,
      );
      const deployedRequirements = this.deps.catalog.deriveGateRequirements(
        pullRequest.changedPaths,
      );
      if (
        snapshot.catalogDigest !== this.deps.catalog.currentDigest() ||
        !sameRequirements(baseRequirements, deployedRequirements)
      ) {
        catalogError = new Error(
          "deployed preview requirements do not match the exact PR base catalog",
        );
      } else {
        requirements = baseRequirements;
      }
    } catch (cause) {
      catalogError = cause instanceof Error ? cause : new Error(String(cause));
    }
    const effectiveRequirements = requirements ?? {
      catalogDigest: this.deps.catalog.currentDigest(),
      contexts: [],
      subjects: {
        "preview/immutable-acceptance": [],
        "preview/activation-images": [],
      },
      requirementDigests: {
        "preview/immutable-acceptance": null,
        "preview/activation-images": null,
      },
      unmappedRuntimePaths: [],
    };
    const contexts = [...new Set(effectiveRequirements.contexts)].sort();
    if (contexts.length !== effectiveRequirements.contexts.length) {
      throw new Error("preview gate catalog returned duplicate requirements");
    }

    let state: PreviewAcceptanceCommitStatus;
    let description: string;
    if (catalogError) {
      state = "error";
      description = "Preview gate catalog does not match the PR base";
    } else if (effectiveRequirements.unmappedRuntimePaths.length > 0) {
      state = "failure";
      description = "Preview gate does not cover every runtime path";
    } else if (contexts.length === 0) {
      state = "success";
      description = "No preview acceptance required";
    } else {
      try {
        const evidenceReceiptDigests = await this.receiptDigests(
          pullRequest,
          contexts,
          effectiveRequirements,
        );
        const observed = await this.deps.statuses.latest({
          repository: pullRequest.repository,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          contexts,
          requirementDigests: effectiveRequirements.requirementDigests,
          evidenceReceiptDigests,
        });
        ({ state, description } = aggregate(contexts, observed));
      } catch (cause) {
        catalogError =
          cause instanceof Error ? cause : new Error(String(cause));
        state = "error";
        description = "Preview evidence receipt could not be verified";
      }
    }

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
      context: "preview/gate",
      state,
      description,
    });
    if (catalogError) throw catalogError;
  }

  private async receiptDigests(
    pullRequest: Awaited<
      ReturnType<PreviewControlPullRequestInspectionPort["inspect"]>
    >,
    contexts: readonly PreviewGateSubordinateContext[],
    requirements: PreviewGateRequirements,
  ): Promise<
    Readonly<Record<PreviewGateSubordinateContext, `sha256:${string}` | null>>
  > {
    const digests: Record<
      PreviewGateSubordinateContext,
      `sha256:${string}` | null
    > = {
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    };
    for (const context of contexts) {
      const receipt = await this.deps.receipts.getByRepoPrHeadContext({
        repository: pullRequest.repository,
        pullRequestNumber: pullRequest.number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
        context,
      });
      if (!receipt) continue;
      assertPreviewAcceptedImageReceiptRequirement(
        receipt,
        {
          repository: pullRequest.repository,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.baseSha,
          headSha: pullRequest.headSha,
          catalogDigest: requirements.catalogDigest,
          context,
          subjects: requirements.subjects[context],
        },
        this.deps.receiptAttestations,
      );
      digests[context] = receipt.receiptDigest;
    }
    return Object.freeze(digests);
  }
}

function sameRequirements(
  left: PreviewGateRequirements,
  right: PreviewGateRequirements,
): boolean {
  const canonical = (value: PreviewGateRequirements) => ({
    catalogDigest: value.catalogDigest,
    contexts: [...value.contexts].sort(),
    subjects: {
      "preview/immutable-acceptance": [
        ...value.subjects["preview/immutable-acceptance"],
      ].sort(),
      "preview/activation-images": [
        ...value.subjects["preview/activation-images"],
      ].sort(),
    },
    requirementDigests: value.requirementDigests,
    unmappedRuntimePaths: [...value.unmappedRuntimePaths].sort(),
  });
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function aggregate(
  contexts: readonly PreviewGateSubordinateContext[],
  observed: Readonly<
    Record<PreviewGateSubordinateContext, PreviewAcceptanceCommitStatus | null>
  >,
): Readonly<{ state: PreviewAcceptanceCommitStatus; description: string }> {
  const states = contexts.map((context) => observed[context]);
  if (states.includes("failure")) {
    return {
      state: "failure",
      description: "Required preview evidence failed",
    };
  }
  if (states.includes("error")) {
    return { state: "error", description: "Required preview evidence errored" };
  }
  if (states.every((state) => state === "success")) {
    return {
      state: "success",
      description: `All ${contexts.length} preview requirement${contexts.length === 1 ? "" : "s"} passed`,
    };
  }
  const complete = states.filter((state) => state === "success").length;
  return {
    state: "pending",
    description: `Preview evidence pending (${complete}/${contexts.length})`,
  };
}
