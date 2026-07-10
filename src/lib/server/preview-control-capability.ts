import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "$env/dynamic/private";
import type {
  PreviewCapabilityBundle,
  PreviewControlIdentity,
} from "$lib/server/application/ports/preview-control";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";

export type {
  PreviewCapabilityBundle,
  PreviewControlIdentity,
} from "$lib/server/application/ports/preview-control";

const ROOT = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{64}$/;

export const PREVIEW_CAPABILITY_PURPOSES = Object.freeze({
  controlToken: "preview-control:v1",
  syncToken: "dev-sync:v1",
  actionToken: "preview-action:v1",
  sandboxToken: "sandbox-execution:v1",
  runtimeToken: "preview-runtime:v1",
  storageToken: "preview-storage:v1",
} as const);

export function localPreviewControlIdentity(
  expectedName?: string,
): PreviewControlIdentity {
  const identity = validatePreviewControlIdentity({
    previewName: (
      env.PREVIEW_ENVIRONMENT_NAME ??
      env.PREVIEW_ENVIRONMENT_ID ??
      process.env.PREVIEW_ENVIRONMENT_NAME ??
      process.env.PREVIEW_ENVIRONMENT_ID ??
      ""
    ).trim(),
    environmentRequestId: (
      env.PREVIEW_ENVIRONMENT_REQUEST_ID ??
      process.env.PREVIEW_ENVIRONMENT_REQUEST_ID ??
      ""
    ).trim(),
    environmentPlatformRevision: (
      env.PREVIEW_ENVIRONMENT_PLATFORM_REVISION ??
      env.PREVIEW_PLATFORM_REVISION ??
      process.env.PREVIEW_ENVIRONMENT_PLATFORM_REVISION ??
      process.env.PREVIEW_PLATFORM_REVISION ??
      ""
    ).trim(),
    environmentSourceRevision: (
      env.PREVIEW_ENVIRONMENT_SOURCE_REVISION ??
      env.PREVIEW_SOURCE_REVISION ??
      process.env.PREVIEW_ENVIRONMENT_SOURCE_REVISION ??
      process.env.PREVIEW_SOURCE_REVISION ??
      ""
    ).trim(),
    catalogDigest: (
      env.PREVIEW_ENVIRONMENT_CATALOG_DIGEST ??
      env.DEV_PREVIEW_CATALOG_DIGEST ??
      process.env.PREVIEW_ENVIRONMENT_CATALOG_DIGEST ??
      process.env.DEV_PREVIEW_CATALOG_DIGEST ??
      ""
    ).trim() as `sha256:${string}`,
  });
  if (expectedName && identity.previewName !== expectedName) {
    throw new Error(
      "preview control identity does not match the requested preview",
    );
  }
  return Object.freeze(identity);
}

export function derivePreviewControlCapability(
  root: string,
  identity: PreviewControlIdentity,
  purpose = "preview-control:v1",
): string {
  if (!ROOT.test(root))
    throw new Error("preview control capability root is invalid");
  validatePreviewControlIdentity(identity);
  const framed = [
    purpose,
    identity.previewName,
    identity.environmentRequestId,
    identity.environmentPlatformRevision,
    identity.environmentSourceRevision,
    identity.catalogDigest,
    "",
  ].join("\n");
  return createHmac("sha256", Buffer.from(root, "hex"))
    .update(framed, "utf8")
    .digest("hex");
}

export function derivePreviewCapabilityBundle(
  root: string,
  identity: PreviewControlIdentity,
): PreviewCapabilityBundle {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PREVIEW_CAPABILITY_PURPOSES).map(([name, purpose]) => [
        name,
        derivePreviewControlCapability(root, identity, purpose),
      ]),
    ) as Record<keyof typeof PREVIEW_CAPABILITY_PURPOSES, string>,
  );
}

export function localPreviewControlCapability(): string {
  const token = (
    env.PREVIEW_CONTROL_CAPABILITY_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_TOKEN ??
    ""
  ).trim();
  if (!TOKEN.test(token)) {
    throw new Error("PREVIEW_CONTROL_CAPABILITY_TOKEN is not configured");
  }
  return token;
}

export function verifyPreviewControlCapability(
  request: Request,
  identity: PreviewControlIdentity,
): boolean {
  const root = (
    env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    ""
  ).trim();
  const supplied =
    request.headers.get("x-preview-control-capability")?.trim() ?? "";
  if (!TOKEN.test(supplied)) return false;
  if (root) {
    if (!ROOT.test(root)) return false;
    const expected = derivePreviewControlCapability(root, identity);
    return timingSafeEqual(
      Buffer.from(supplied, "hex"),
      Buffer.from(expected, "hex"),
    );
  }

  // A preview receives only its leaf token. Bind that token to the immutable
  // local tuple before accepting a reverse control-plane call.
  let localIdentity: PreviewControlIdentity;
  let expected: string;
  try {
    localIdentity = localPreviewControlIdentity(identity.previewName);
    expected = localPreviewControlCapability();
  } catch {
    return false;
  }
  if (
    localIdentity.environmentRequestId !== identity.environmentRequestId ||
    localIdentity.environmentPlatformRevision !==
      identity.environmentPlatformRevision ||
    localIdentity.environmentSourceRevision !==
      identity.environmentSourceRevision ||
    localIdentity.catalogDigest !== identity.catalogDigest
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(supplied, "hex"),
    Buffer.from(expected, "hex"),
  );
}

/** Physical-only verification for a non-control purpose leaf and header. */
export function verifyPreviewCapabilityPurpose(
  request: Request,
  identity: PreviewControlIdentity,
  purpose: string,
  headerName: string,
): boolean {
  const root = (
    env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    ""
  ).trim();
  const supplied = request.headers.get(headerName)?.trim() ?? "";
  if (!ROOT.test(root) || !TOKEN.test(supplied)) return false;
  let expected: string;
  try {
    expected = derivePreviewControlCapability(root, identity, purpose);
  } catch {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(supplied, "hex"),
    Buffer.from(expected, "hex"),
  );
}
