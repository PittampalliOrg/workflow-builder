import { createHash, timingSafeEqual } from "node:crypto";
import { error } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import {
  localPreviewControlIdentity,
  PREVIEW_CAPABILITY_PURPOSES,
  verifyPreviewCapabilityPurpose,
  verifyPreviewControlCapability,
  type PreviewControlIdentity,
} from "$lib/server/preview-control-capability";

/**
 * Validate that the request carries the correct internal API token.
 *
 * The token is sourced from the `INTERNAL_API_TOKEN` env var (populated from
 * the Dapr secret store / Azure Key Vault key `INTERNAL-API-TOKEN`).
 *
 * Callers pass the token via:
 *   - `X-Internal-Token` header (preferred), or
 *   - `Authorization: Bearer <token>` header
 */
export function validateInternalToken(request: Request): boolean {
  const expected = env.INTERNAL_API_TOKEN;
  if (!expected) {
    return false;
  }
  const token =
    request.headers.get("x-internal-token") ||
    request.headers.get("authorization")?.replace("Bearer ", "");
  return !!token && token === expected;
}

/**
 * Throw a 401 if the request doesn't carry a valid INTERNAL_API_TOKEN.
 * Convenience wrapper for SvelteKit request handlers on /api/internal/*
 * routes.
 */
export function requireInternal(request: Request): void {
  if (!validateInternalToken(request)) {
    throw error(401, "invalid or missing INTERNAL_API_TOKEN");
  }
}

/**
 * Validate the isolated credential used only by privileged dev-preview actions.
 * This deliberately does not accept INTERNAL_API_TOKEN or a bearer fallback.
 */
export function validatePreviewActionInternalToken(request: Request): boolean {
  const expected = env.PREVIEW_ACTION_INTERNAL_TOKEN?.trim();
  if (!expected) return false;
  const token = request.headers.get("x-preview-action-token")?.trim();
  return !!token && token === expected;
}

/** Fail closed when the dedicated preview-action credential is absent or wrong. */
export function requirePreviewActionInternal(request: Request): void {
  if (!validatePreviewActionInternalToken(request)) {
    throw error(401, "invalid or missing PREVIEW_ACTION_INTERNAL_TOKEN");
  }
}

/** Dedicated immutable preview-control broker credential; no token fallback. */
export function validatePreviewControlBrokerToken(request: Request): boolean {
  const expected = env.PREVIEW_CONTROL_BROKER_TOKEN?.trim();
  if (!expected) return false;
  const token = request.headers.get("x-preview-control-broker-token")?.trim();
  return !!token && token === expected;
}

export function requirePreviewControlBroker(request: Request): void {
  if (!validatePreviewControlBrokerToken(request)) {
    throw error(401, "invalid or missing PREVIEW_CONTROL_BROKER_TOKEN");
  }
}

/** Purpose-specific hub outer-loop credential; generic internal tokens are rejected. */
export function validatePreviewAcceptedImageReuseToken(
  request: Request,
): boolean {
  const expected = env.PREVIEW_ACCEPTED_IMAGE_REUSE_TOKEN?.trim();
  const token = request.headers.get("x-preview-accepted-image-reuse")?.trim();
  if (!expected || !token) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const tokenDigest = createHash("sha256").update(token).digest();
  return timingSafeEqual(expectedDigest, tokenDigest);
}

export function requirePreviewAcceptedImageReuse(request: Request): void {
  if (!validatePreviewAcceptedImageReuseToken(request)) {
    throw error(401, "invalid or missing PREVIEW_ACCEPTED_IMAGE_REUSE_TOKEN");
  }
}

/** Dedicated hub webhook credential; broad internal and broker tokens are rejected. */
export function validatePreviewGovernanceDispatchToken(
  request: Request,
): boolean {
  const expected = env.PREVIEW_GOVERNANCE_DISPATCH_TOKEN?.trim();
  const token = request.headers.get("x-preview-governance-dispatch")?.trim();
  if (!expected || !token) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const tokenDigest = createHash("sha256").update(token).digest();
  return timingSafeEqual(expectedDigest, tokenDigest);
}

export function requirePreviewGovernanceDispatch(request: Request): void {
  if (!validatePreviewGovernanceDispatchToken(request)) {
    throw error(401, "invalid or missing PREVIEW_GOVERNANCE_DISPATCH_TOKEN");
  }
}

/** Per-preview capability for every mutable-preview/physical-control call. */
export function requirePreviewControlCapability(
  request: Request,
  identity: PreviewControlIdentity,
): void {
  if (!verifyPreviewControlCapability(request, identity)) {
    throw error(401, "invalid or mismatched preview control capability");
  }
}

/** Mint-only preview sync bearer; cannot authorize build, promotion, or runtime APIs. */
export function requirePreviewDevSyncMintCapability(
  request: Request,
  identity: PreviewControlIdentity,
): void {
  if (
    !verifyPreviewCapabilityPurpose(
      request,
      identity,
      PREVIEW_CAPABILITY_PURPOSES.syncToken,
      "x-preview-dev-sync-mint-token",
    )
  ) {
    throw error(401, "invalid or mismatched preview dev-sync mint capability");
  }
}

/** Read-only preview routes accept either normal service auth or the local leaf. */
export function validateInternalOrPreviewControlRead(
  request: Request,
): boolean {
  if (validateInternalToken(request)) return true;
  try {
    const identity = localPreviewControlIdentity();
    return verifyPreviewControlCapability(request, identity);
  } catch {
    return false;
  }
}

export function requireInternalOrPreviewControlRead(request: Request): void {
  if (!validateInternalOrPreviewControlRead(request)) {
    throw error(401, "invalid preview read capability");
  }
}
