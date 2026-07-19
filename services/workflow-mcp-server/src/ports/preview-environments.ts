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

export type PreviewTraceQuery = {
  range?: "15m" | "1h" | "6h" | "24h" | "7d";
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
