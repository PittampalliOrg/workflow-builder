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
  body: ReadableStream<Uint8Array> | null;
}>;

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
