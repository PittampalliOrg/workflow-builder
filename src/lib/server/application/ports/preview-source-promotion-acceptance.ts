import type { PreviewAcceptanceBrokerResult } from "./preview-control";

/**
 * Opaque acceptance command from an isolated preview to physical control.
 * The preview never supplies the pull-request SHAs accepted by the physical
 * broker; those are resolved from its durable promotion receipt.
 */
export type PreviewSourcePromotionAcceptanceRequest = Readonly<{
  requestId: string;
  previewName: string;
  environmentRequestId: string;
  environmentPlatformRevision: string;
  environmentSourceRevision: string;
  catalogDigest: `sha256:${string}`;
  executionId: string;
  receiptId: string;
}>;

export interface PreviewSourcePromotionAcceptancePort {
  replay(
    input: PreviewSourcePromotionAcceptanceRequest,
  ): Promise<PreviewAcceptanceBrokerResult>;
}
