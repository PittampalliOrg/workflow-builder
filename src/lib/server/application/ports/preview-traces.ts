import type {
  PreviewTraceQueryView,
  PreviewTraceRange,
  PreviewTraceStatus,
} from "$lib/types/dev-previews";
import type {
  AuthorizedPreviewControlSource,
  PreviewControlIdentity,
} from "./preview-control";

export type PreviewTraceQuery = Readonly<{
  range: PreviewTraceRange;
  status: PreviewTraceStatus;
  service: string | null;
  search: string | null;
  limit: number;
}>;

export type PreviewTraceQueryReceipt = PreviewTraceQueryView &
  Readonly<{ identity: PreviewControlIdentity }>;

const NARROWER_RANGES: Readonly<
  Partial<Record<PreviewTraceRange, PreviewTraceRange>>
> = Object.freeze({
  "7d": "24h",
  "24h": "6h",
  "6h": "1h",
  "1h": "15m",
});

export function narrowerPreviewTraceRange(
  range: PreviewTraceRange,
): PreviewTraceRange | null {
  return NARROWER_RANGES[range] ?? null;
}

/** Bounded trace evidence exceeded its read budget; callers may retry a narrower range. */
export class PreviewTraceQueryTimeoutError extends Error {
  readonly code = "preview_trace_timeout";
  readonly retryRange: PreviewTraceRange | null;

  constructor(
    readonly range: PreviewTraceRange,
    readonly timeoutMs: number | null = null,
    retryRange: PreviewTraceRange | null = narrowerPreviewTraceRange(range),
  ) {
    super(
      retryRange
        ? `Preview trace query timed out for range ${range}; retry with range ${retryRange}`
        : `Preview trace query timed out for range ${range}`,
    );
    this.name = "PreviewTraceQueryTimeoutError";
    this.retryRange = retryRange;
  }
}

/** Exact-tuple telemetry query. Implementations return summaries, never raw SQL access. */
export interface PreviewTraceQueryPort {
  query(
    input: Readonly<{
      identity: PreviewControlIdentity;
      query: PreviewTraceQuery;
    }>,
  ): Promise<PreviewTraceQueryReceipt>;
}

/** Read-only exact-generation authority, distinct from runtime egress policy. */
export interface PreviewTraceSourceAuthorityPort {
  authorizeTraceTuple(
    input: PreviewControlIdentity,
  ): Promise<AuthorizedPreviewControlSource>;
}
