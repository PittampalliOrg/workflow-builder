import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptedImageReceiptAttestationPort,
  PreviewAcceptedImageReceiptStorePort,
  PreviewAcceptedImageReusePort,
  PreviewAcceptedImageReuseRequest,
  PreviewAcceptedImageReuseResult,
  PreviewMergedCommitInspectionPort,
} from "$lib/server/application/ports";
import { assertPreviewAcceptedImageReceiptRequirement } from "$lib/server/application/preview-accepted-images";

const FULL_SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUBJECT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export class PreviewAcceptedImageReuseInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewAcceptedImageReuseInputError";
  }
}

type PreviewAcceptedImageReuseDeps = Readonly<{
  merges: PreviewMergedCommitInspectionPort;
  receipts: PreviewAcceptedImageReceiptStorePort;
  attestations: PreviewAcceptedImageReceiptAttestationPort;
  catalog: PreviewAcceptanceChangedServiceCatalogPort;
  sourceRepository: string;
}>;

/** Selects an accepted image only when merged content and catalog paths remain identical. */
export class ApplicationPreviewAcceptedImageReuseService implements PreviewAcceptedImageReusePort {
  constructor(private readonly deps: PreviewAcceptedImageReuseDeps) {}

  async resolve(
    input: PreviewAcceptedImageReuseRequest,
  ): Promise<PreviewAcceptedImageReuseResult> {
    this.validate(input);
    const merge = await this.deps.merges.inspect({
      repository: input.repository,
      mergeSha: input.mergeSha,
    });
    if (!merge) return build("merge-not-proven");
    if (merge.headTreeSha !== merge.mergeTreeSha) return build("content-drift");

    let receipt;
    try {
      receipt = await this.deps.receipts.getByRepoPrHeadContext({
        repository: merge.repository,
        pullRequestNumber: merge.pullRequestNumber,
        baseSha: merge.baseSha,
        headSha: merge.headSha,
        context: input.context,
      });
    } catch {
      return build("receipt-untrusted");
    }
    if (!receipt) return build("receipt-absent");
    if (receipt.catalogDigest !== this.deps.catalog.currentDigest()) {
      return build("catalog-drift");
    }

    const changed = this.deps.catalog.deriveChangedServices(merge.changedPaths);
    if (changed.unmappedRuntimePaths.length > 0) return build("subject-drift");
    const expected = canonicalStrings(
      input.context === "preview/immutable-acceptance"
        ? changed.services
        : changed.activationArtifacts,
    );
    const actual = canonicalStrings(
      receipt.subjects.map(({ subject }) => subject),
    );
    if (!sameStrings(expected, actual)) return build("subject-drift");
    try {
      assertPreviewAcceptedImageReceiptRequirement(
        receipt,
        {
          repository: merge.repository,
          pullRequestNumber: merge.pullRequestNumber,
          baseSha: merge.baseSha,
          headSha: merge.headSha,
          catalogDigest: receipt.catalogDigest,
          context: input.context,
          subjects: expected,
        },
        this.deps.attestations,
      );
    } catch {
      return build("receipt-untrusted");
    }

    const image = receipt.subjects.find(
      ({ subject }) => subject === input.subject,
    );
    if (!image) return build("subject-absent");
    return Object.freeze({
      ok: true,
      disposition: "reuse",
      mergeSha: merge.mergeSha,
      pullRequestNumber: merge.pullRequestNumber,
      baseSha: merge.baseSha,
      headSha: merge.headSha,
      receiptDigest: receipt.receiptDigest,
      image,
    });
  }

  private validate(input: PreviewAcceptedImageReuseRequest): void {
    if (
      input.repository !== this.deps.sourceRepository ||
      !REPOSITORY.test(input.repository) ||
      !FULL_SHA.test(input.mergeSha) ||
      !SUBJECT.test(input.subject) ||
      !["preview/immutable-acceptance", "preview/activation-images"].includes(
        input.context,
      )
    ) {
      throw new PreviewAcceptedImageReuseInputError(
        "accepted image reuse request is invalid",
      );
    }
  }
}

function build(
  reason: Extract<PreviewAcceptedImageReuseResult, { ok: false }>["reason"],
): PreviewAcceptedImageReuseResult {
  return Object.freeze({ ok: false, disposition: "build", reason });
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
