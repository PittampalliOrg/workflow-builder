import type { PreviewControlIdentity } from "$lib/server/application/ports/preview-control";

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Validate the immutable preview tuple without reading environment or transport state. */
export function validatePreviewControlIdentity(
  value: PreviewControlIdentity,
): PreviewControlIdentity {
  if (
    !PREVIEW_NAME.test(value.previewName) ||
    !SAFE_ID.test(value.environmentRequestId) ||
    !FULL_SHA.test(value.environmentPlatformRevision) ||
    !FULL_SHA.test(value.environmentSourceRevision) ||
    !SHA256.test(value.catalogDigest)
  ) {
    throw new Error("preview control identity is invalid");
  }
  return value;
}
