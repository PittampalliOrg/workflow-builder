import { createHash } from "node:crypto";

/**
 * Immutable Dapr workflow instance id for one provisioning generation.
 * Shared runtime pools cannot use a generation-specific app id, so the durable
 * instance itself is the generation fence common to every hosting mode.
 */
export function sessionRuntimeGenerationInstanceId(
  sessionId: string,
  provisioningStartedAt: Date,
): string | null {
  const normalized = sessionId.trim();
  if (!normalized || !Number.isFinite(provisioningStartedAt.getTime())) {
    return null;
  }
  const identity = `${normalized}\0${provisioningStartedAt.toISOString()}`;
  return `session-runtime-${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}
