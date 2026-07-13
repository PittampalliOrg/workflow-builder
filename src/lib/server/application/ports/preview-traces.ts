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
