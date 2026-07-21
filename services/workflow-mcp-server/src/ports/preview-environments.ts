export type PreviewEnvironmentSummary = {
  name: string;
  phase: string;
  ready: boolean;
  url: string | null;
  targetCluster: string;
  lifecycle: string | null;
  expiresAt: string | null;
  platformRevision: string | null;
  sourceRevision: string | null;
  catalogDigest: string | null;
  services: string[] | null;
  provenance: Record<string, unknown> | null;
};

export type PreviewEnvironmentFleet = {
  previews: PreviewEnvironmentSummary[];
  counts: unknown;
};

export type PreviewEnvironmentLaunchInput = {
  name: string;
  services?: string[];
  sourceRef?: string;
  ttlHours?: number;
  lifecycle?: "ephemeral" | "retained";
};

export type PreviewTraceRange = "15m" | "1h" | "6h" | "24h" | "7d";

const NARROWER_PREVIEW_TRACE_RANGE: Readonly<
  Partial<Record<PreviewTraceRange, PreviewTraceRange>>
> = Object.freeze({
  "7d": "24h",
  "24h": "6h",
  "6h": "1h",
  "1h": "15m",
});

export function parsePreviewTraceRange(
  value: unknown,
): PreviewTraceRange | null {
  return value === "15m" ||
    value === "1h" ||
    value === "6h" ||
    value === "24h" ||
    value === "7d"
    ? value
    : null;
}

export function narrowerPreviewTraceRange(
  range: PreviewTraceRange,
): PreviewTraceRange | null {
  return NARROWER_PREVIEW_TRACE_RANGE[range] ?? null;
}

export type PreviewTraceQuery = {
  range?: PreviewTraceRange;
  status?: "all" | "ok" | "error";
  service?: string;
  search?: string;
  limit?: number;
};

export type PreviewTraceResult = {
  traces: unknown[];
  services: string[];
  observedAt: string;
};

export type PreviewTeardownTicket = {
  name: string;
  environmentUid: string;
  requestId: string;
  sourceRevision: string;
  signature: string;
};

export type PreviewTeardownInput = {
  expectedRequestId: string;
  expectedSourceRevision: string;
  forceFailed?: boolean;
  discardUnarchived?: boolean;
};

/** Stable driven-port failure contract; transport details stay in the adapter. */
export class PreviewEnvironmentRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PreviewEnvironmentRequestError";
  }
}

/** Product-level preview operations. Cluster and telemetry credentials stay behind the BFF. */
export interface PreviewEnvironmentsPort {
  list(): Promise<PreviewEnvironmentFleet>;
  listServices(): Promise<{ services: unknown[] }>;
  get(name: string): Promise<{ preview: PreviewEnvironmentSummary }>;
  launch(
    input: PreviewEnvironmentLaunchInput,
  ): Promise<{ preview: PreviewEnvironmentSummary; pooled: boolean }>;
  getRuntime(name: string): Promise<{ runtime: unknown }>;
  queryTraces(
    name: string,
    query: PreviewTraceQuery,
  ): Promise<PreviewTraceResult>;
  teardown(
    name: string,
    input: PreviewTeardownInput,
  ): Promise<{
    preview: PreviewEnvironmentSummary;
    teardown: PreviewTeardownTicket | null;
    archive?: unknown;
  }>;
  getTeardownStatus(
    ticket: PreviewTeardownTicket,
  ): Promise<{ teardown: unknown; ticket: PreviewTeardownTicket }>;
}
