import type {
  PreviewAcceptanceBrokerPort,
  PreviewAcceptanceBrokerResult,
  PreviewControlPullRequestInspectionPort,
  ImmutableGitSha,
  PreviewSourcePromotionAcceptancePort,
  PreviewSourcePromotionAcceptanceRequest,
  PreviewSourcePromotionReceiptStorePort,
} from "$lib/server/application/ports";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

export class PreviewSourcePromotionAcceptanceError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 400 | 409,
  ) {
    super(message);
    this.name = "PreviewSourcePromotionAcceptanceError";
  }
}

type Deps = Readonly<{
  receipts: PreviewSourcePromotionReceiptStorePort;
  pullRequests: PreviewControlPullRequestInspectionPort;
  acceptance: PreviewAcceptanceBrokerPort;
  sourceRepository: string;
  baseBranch: string;
}>;

/** Physical-only resolver from an opaque promotion receipt to exact PR proof. */
export class ApplicationPreviewSourcePromotionAcceptanceService
  implements PreviewSourcePromotionAcceptancePort
{
  constructor(private readonly deps: Deps) {}

  async replay(
    input: PreviewSourcePromotionAcceptanceRequest,
  ): Promise<PreviewAcceptanceBrokerResult> {
    if (
      !SAFE_ID.test(input.requestId) ||
      !SAFE_ID.test(input.executionId) ||
      !SAFE_ID.test(input.receiptId)
    ) {
      throw new PreviewSourcePromotionAcceptanceError(
        "promotion acceptance command is invalid",
        400,
      );
    }
    const receipt = await this.deps.receipts.getScoped({
      receiptId: input.receiptId,
      previewName: input.previewName,
      requestId: input.environmentRequestId,
      executionId: input.executionId,
      platformRevision: input.environmentPlatformRevision as ImmutableGitSha,
      sourceRevision: input.environmentSourceRevision as ImmutableGitSha,
      catalogDigest: input.catalogDigest,
      repository: this.deps.sourceRepository,
      baseBranch: this.deps.baseBranch,
    });
    if (!receipt || !receipt.draft) {
      throw new PreviewSourcePromotionAcceptanceError(
        "promotion receipt is not available for this preview session",
        409,
      );
    }
    const pullRequest = await this.deps.pullRequests.inspectOpen({
      repository: receipt.repository,
      number: receipt.pullRequestNumber,
    });
    if (
      !pullRequest.draft ||
      pullRequest.repository !== receipt.repository ||
      pullRequest.number !== receipt.pullRequestNumber ||
      pullRequest.headRef !== receipt.branch ||
      pullRequest.headSha !== receipt.commitSha ||
      !FULL_SHA.test(pullRequest.baseSha) ||
      pullRequest.baseSha === pullRequest.headSha ||
      !sameStrings(pullRequest.changedPaths, receipt.changedPaths)
    ) {
      throw new PreviewSourcePromotionAcceptanceError(
        "promotion receipt no longer matches the live draft pull request",
        409,
      );
    }
    return this.deps.acceptance.replay({
      requestId: input.requestId,
      previewName: input.previewName,
      environmentRequestId: input.environmentRequestId,
      environmentPlatformRevision: input.environmentPlatformRevision,
      environmentSourceRevision: input.environmentSourceRevision,
      catalogDigest: input.catalogDigest,
      pullRequest: {
        repository: receipt.repository,
        number: receipt.pullRequestNumber,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      },
    });
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
