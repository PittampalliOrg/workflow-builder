import type { PreviewControlIdentity } from "./preview-control";

export type PreviewRuntimeCompletionRequest = Readonly<{
  identity: PreviewControlIdentity;
  capability: string;
  payload: Readonly<Record<string, unknown>>;
}>;

export type PreviewRuntimeCompletionResponse = Readonly<{
  status: number;
  contentType: string;
  requestId: string | null;
  retryAfter?: string | null;
  body: ReadableStream<Uint8Array> | null;
}>;

/** Fixed-window and lifetime limits for one immutable preview identity. */
export type PreviewRuntimeBudgetLimits = Readonly<{
  requestsPerMinute: number;
  reservedTokensPerMinute: number;
  totalRequests: number;
  totalReservedTokens: number;
}>;

export type PreviewRuntimeBudgetDenialReason =
  | "identity-closed"
  | "minute-request-limit"
  | "minute-token-limit"
  | "total-request-limit"
  | "total-token-limit";

export type PreviewRuntimeBudgetReservation =
  | Readonly<{
      ok: true;
      minuteRequests: number;
      minuteReservedTokens: number;
      totalRequests: number;
      totalReservedTokens: number;
    }>
  | Readonly<{
      ok: false;
      reason: PreviewRuntimeBudgetDenialReason;
    }>;

/**
 * Durable, replica-shared reservation boundary. Implementations must atomically
 * evaluate and increment every counter for the exact PreviewControlIdentity.
 */
export interface PreviewRuntimeBudgetReservationPort {
  reserve(
    input: Readonly<{
      identity: PreviewControlIdentity;
      reservedTokens: number;
      limits: PreviewRuntimeBudgetLimits;
    }>,
  ): Promise<PreviewRuntimeBudgetReservation>;
}

/**
 * Teardown-side budget lifecycle. Closing is exact and idempotent; the retained
 * tombstone blocks a late already-authorized request until bounded pruning.
 */
export interface PreviewRuntimeBudgetCleanupPort {
  close(
    input: Readonly<{
      identity: PreviewControlIdentity;
      retentionHours: number;
    }>,
  ): Promise<void>;
  pruneExpired(limit: number): Promise<number>;
}

/** Verifies the tuple-scoped leaf capability without exposing its HMAC root. */
export interface PreviewRuntimeCapabilityVerificationPort {
  verify(
    input: Readonly<{
      identity: PreviewControlIdentity;
      capability: string;
    }>,
  ): boolean;
}

/** Fixed OpenAI-compatible egress. Callers cannot supply a URL or headers. */
export interface PreviewRuntimeUpstreamPort {
  complete(
    input: Readonly<{
      identity: PreviewControlIdentity;
      payload: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<PreviewRuntimeCompletionResponse>;
}

export interface PreviewRuntimeBrokerPort {
  complete(
    input: PreviewRuntimeCompletionRequest,
  ): Promise<PreviewRuntimeCompletionResponse>;
}
