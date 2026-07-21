import { env } from "$env/dynamic/private";
import type {
  PreviewControlIdentity,
  PreviewTraceQuery,
  PreviewTraceQueryPort,
  PreviewTraceQueryReceipt,
} from "$lib/server/application/ports";
import {
  narrowerPreviewTraceRange,
  PreviewRuntimeIdentityChangedError,
  PreviewTraceQueryTimeoutError,
} from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  localPreviewControlCapability,
  localPreviewControlIdentity,
} from "$lib/server/preview-control-capability";
import {
  CLICKHOUSE_DB,
  escapeClickHouseString,
  queryClickHouse,
} from "$lib/server/otel/clickhouse";
import type { PreviewTraceSummary } from "$lib/types/dev-previews";

type ClickHouseQuery = (
  sql: string,
  options?: { timeoutMs?: number },
) => Promise<Record<string, unknown>[]>;
type Credential = Readonly<{ header: string; token: string }>;

export const DEFAULT_PREVIEW_TRACE_QUERY_TIMEOUT_MS = 12_000;
export const DEFAULT_PREVIEW_TRACE_BROKER_TIMEOUT_MS = 18_000;

const INTERVALS: Readonly<Record<PreviewTraceQuery["range"], string>> = {
  "15m": "15 MINUTE",
  "1h": "1 HOUR",
  "6h": "6 HOUR",
  "24h": "24 HOUR",
  "7d": "7 DAY",
};
const TOKEN = /^[0-9a-f]{64}$/;
const TRACE_ID = /^[0-9a-f]{16,64}$/i;
const MAX_RESPONSE_BYTES = 512 * 1024;
const TRACE_RANGES = new Set<PreviewTraceQuery["range"]>([
  "15m",
  "1h",
  "6h",
  "24h",
  "7d",
]);

function boundedTimeout(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function timeoutCause(cause: unknown): boolean {
  return (
    cause instanceof PreviewTraceQueryTimeoutError ||
    (cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError"))
  );
}

function traceRange(value: unknown): PreviewTraceQuery["range"] | null {
  return typeof value === "string" &&
    TRACE_RANGES.has(value as PreviewTraceQuery["range"])
    ? (value as PreviewTraceQuery["range"])
    : null;
}

function sameIdentity(
  left: PreviewControlIdentity,
  right: PreviewControlIdentity,
): boolean {
  return (
    left.previewName === right.previewName &&
    left.environmentRequestId === right.environmentRequestId &&
    left.environmentPlatformRevision === right.environmentPlatformRevision &&
    left.environmentSourceRevision === right.environmentSourceRevision &&
    left.catalogDigest === right.catalogDigest
  );
}

function exactTupleClauses(
  identity: PreviewControlIdentity,
  interval: string,
): string[] {
  const attribute = (name: string, value: string) =>
    `ResourceAttributes['${name}'] = '${escapeClickHouseString(value)}'`;
  return [
    `Timestamp > now() - INTERVAL ${interval}`,
    attribute("deployment.environment", "dev-preview"),
    attribute("preview.name", identity.previewName),
    attribute("preview.request_id", identity.environmentRequestId),
    attribute(
      "preview.platform_revision",
      identity.environmentPlatformRevision,
    ),
    attribute("preview.source_revision", identity.environmentSourceRevision),
    attribute("preview.catalog_digest", identity.catalogDigest),
  ];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function traceSummary(
  row: Record<string, unknown>,
): PreviewTraceSummary | null {
  const traceId = stringValue(row.TraceId);
  if (!TRACE_ID.test(traceId)) return null;
  return {
    traceId,
    rootOperation: stringValue(row.RootOperation) || "unknown operation",
    rootService: stringValue(row.RootService) || "unknown service",
    services: stringArray(row.Services).slice(0, 20),
    startTime: stringValue(row.StartTime),
    durationMs: Math.max(0, Math.round(Number(row.DurationMs) || 0)),
    spanCount: Math.max(0, Math.round(Number(row.SpanCount) || 0)),
    status: Number(row.HasError) === 1 ? "error" : "ok",
  };
}

/** Physical adapter. Every SQL statement includes all five immutable tuple attributes. */
export class ClickHousePreviewTraceQueryAdapter implements PreviewTraceQueryPort {
  private readonly timeoutMs: number;

  constructor(
    private readonly queryImpl: ClickHouseQuery = queryClickHouse,
    private readonly now: () => Date = () => new Date(),
    options: Readonly<{ timeoutMs?: number }> = {},
  ) {
    this.timeoutMs = boundedTimeout(
      options.timeoutMs ??
        env.PREVIEW_TRACE_QUERY_TIMEOUT_MS ??
        process.env.PREVIEW_TRACE_QUERY_TIMEOUT_MS,
      DEFAULT_PREVIEW_TRACE_QUERY_TIMEOUT_MS,
      1_000,
      60_000,
    );
  }

  async query(
    input: Readonly<{
      identity: PreviewControlIdentity;
      query: PreviewTraceQuery;
    }>,
  ): Promise<PreviewTraceQueryReceipt> {
    const identity = validatePreviewControlIdentity(input.identity);
    const interval = INTERVALS[input.query.range];
    const tuple = exactTupleClauses(identity, interval);
    const having: string[] = [];
    if (input.query.service) {
      having.push(
        `countIf(ServiceName = '${escapeClickHouseString(input.query.service)}') > 0`,
      );
    }
    if (input.query.search) {
      const search = escapeClickHouseString(input.query.search);
      having.push(
        `countIf(positionCaseInsensitive(TraceId, '${search}') > 0 OR ` +
          `positionCaseInsensitive(SpanName, '${search}') > 0 OR ` +
          `positionCaseInsensitive(ServiceName, '${search}') > 0) > 0`,
      );
    }
    if (input.query.status === "error") having.push("HasError = 1");
    if (input.query.status === "ok") having.push("HasError = 0");
    const havingSql = having.length > 0 ? `HAVING ${having.join(" AND ")}` : "";
    const traceSql = `
      SELECT
        TraceId,
        min(Timestamp) AS StartTime,
        (max(toUnixTimestamp64Nano(Timestamp) + Duration) - min(toUnixTimestamp64Nano(Timestamp))) / 1e6 AS DurationMs,
        count() AS SpanCount,
        coalesce(nullIf(anyIf(SpanName, ParentSpanId = ''), ''), argMin(SpanName, Timestamp)) AS RootOperation,
        coalesce(nullIf(anyIf(ServiceName, ParentSpanId = ''), ''), argMin(ServiceName, Timestamp)) AS RootService,
        arraySlice(arraySort(groupUniqArray(ServiceName)), 1, 20) AS Services,
        maxIf(1, positionCaseInsensitive(toString(StatusCode), 'error') > 0) AS HasError
      FROM ${CLICKHOUSE_DB}.otel_traces
      WHERE ${tuple.join(" AND ")}
      GROUP BY TraceId
      ${havingSql}
      ORDER BY StartTime DESC
      LIMIT ${input.query.limit}
    `;
    const serviceSql = `
      SELECT DISTINCT ServiceName
      FROM ${CLICKHOUSE_DB}.otel_traces
      WHERE ${tuple.join(" AND ")}
      ORDER BY ServiceName
      LIMIT 200
    `;
    let traceRows: Record<string, unknown>[];
    let serviceRows: Record<string, unknown>[];
    try {
      [traceRows, serviceRows] = await Promise.all([
        this.queryImpl(traceSql, { timeoutMs: this.timeoutMs }),
        this.queryImpl(serviceSql, { timeoutMs: this.timeoutMs }),
      ]);
    } catch (cause) {
      if (cause instanceof PreviewTraceQueryTimeoutError) throw cause;
      if (timeoutCause(cause)) {
        throw new PreviewTraceQueryTimeoutError(
          input.query.range,
          this.timeoutMs,
        );
      }
      throw cause;
    }
    return Object.freeze({
      identity,
      traces: traceRows
        .map(traceSummary)
        .filter((trace): trace is PreviewTraceSummary => trace !== null),
      services: serviceRows
        .map((row) => stringValue(row.ServiceName))
        .filter(Boolean),
      observedAt: this.now().toISOString(),
    });
  }
}

export class PreviewTraceTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewTraceTransportError";
  }
}

export type HttpPreviewTraceQueryOptions = Readonly<{
  baseUrl?: () => string | null;
  credential?: (identity: PreviewControlIdentity) => Credential;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}>;

function defaultCredential(identity: PreviewControlIdentity): Credential {
  const leaf = (
    env.PREVIEW_CONTROL_CAPABILITY_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_TOKEN ??
    ""
  ).trim();
  if (TOKEN.test(leaf)) {
    const local = localPreviewControlIdentity(identity.previewName);
    if (!sameIdentity(local, identity)) {
      throw new PreviewTraceTransportError(
        "local preview identity does not match the requested trace generation",
      );
    }
    return {
      header: "X-Preview-Control-Capability",
      token: localPreviewControlCapability(),
    };
  }
  const broker = (
    env.PREVIEW_CONTROL_BROKER_TOKEN ??
    process.env.PREVIEW_CONTROL_BROKER_TOKEN ??
    ""
  ).trim();
  if (!broker) {
    throw new PreviewTraceTransportError(
      "preview trace broker credential is not configured",
    );
  }
  return { header: "X-Preview-Control-Broker-Token", token: broker };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseIdentity(value: unknown): PreviewControlIdentity {
  const input = record(value);
  if (!input)
    throw new PreviewTraceTransportError(
      "preview trace receipt identity is invalid",
    );
  try {
    return validatePreviewControlIdentity(input as PreviewControlIdentity);
  } catch {
    throw new PreviewTraceTransportError(
      "preview trace receipt identity is invalid",
    );
  }
}

function parseTrace(value: unknown): PreviewTraceSummary {
  const input = record(value);
  if (
    !input ||
    typeof input.traceId !== "string" ||
    !TRACE_ID.test(input.traceId) ||
    typeof input.rootOperation !== "string" ||
    typeof input.rootService !== "string" ||
    !Array.isArray(input.services) ||
    input.services.some((service) => typeof service !== "string") ||
    typeof input.startTime !== "string" ||
    typeof input.durationMs !== "number" ||
    typeof input.spanCount !== "number" ||
    (input.status !== "ok" && input.status !== "error")
  ) {
    throw new PreviewTraceTransportError(
      "preview trace broker returned an invalid trace summary",
    );
  }
  return input as PreviewTraceSummary;
}

/** Candidate/control-plane adapter to the physical tuple-authenticated broker route. */
export class HttpPreviewTraceQueryAdapter implements PreviewTraceQueryPort {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpPreviewTraceQueryOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = boundedTimeout(
      options.timeoutMs ??
        env.PREVIEW_TRACE_BROKER_TIMEOUT_MS ??
        process.env.PREVIEW_TRACE_BROKER_TIMEOUT_MS,
      DEFAULT_PREVIEW_TRACE_BROKER_TIMEOUT_MS,
      1_000,
      60_000,
    );
  }

  async query(
    input: Readonly<{
      identity: PreviewControlIdentity;
      query: PreviewTraceQuery;
    }>,
  ): Promise<PreviewTraceQueryReceipt> {
    const identity = validatePreviewControlIdentity(input.identity);
    const baseUrl = (
      this.options.baseUrl?.() ??
      env.PREVIEW_CONTROL_BROKER_URL ??
      process.env.PREVIEW_CONTROL_BROKER_URL ??
      ""
    )
      .trim()
      .replace(/\/+$/, "");
    if (!baseUrl)
      throw new PreviewTraceTransportError(
        "preview trace broker URL is not configured",
      );
    const credential = (this.options.credential ?? defaultCredential)(identity);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${baseUrl}/api/internal/preview-control/environment/traces`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [credential.header]: credential.token,
          },
          body: JSON.stringify({ identity, query: input.query }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (cause) {
      if (timeoutCause(cause)) {
        throw new PreviewTraceQueryTimeoutError(
          input.query.range,
          this.timeoutMs,
        );
      }
      throw new PreviewTraceTransportError(
        `preview trace broker is unavailable: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_RESPONSE_BYTES) {
      throw new PreviewTraceTransportError(
        "preview trace broker response is too large",
      );
    }
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      if (timeoutCause(cause)) {
        throw new PreviewTraceQueryTimeoutError(
          input.query.range,
          this.timeoutMs,
        );
      }
      throw new PreviewTraceTransportError(
        "preview trace broker response could not be read",
      );
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new PreviewTraceTransportError(
        "preview trace broker response is too large",
      );
    }
    let body: Record<string, unknown> | null;
    try {
      body = record(text ? JSON.parse(text) : null);
    } catch {
      throw new PreviewTraceTransportError(
        "preview trace broker returned invalid JSON",
      );
    }
    if (!response.ok) {
      const code = typeof body?.code === "string" ? body.code : null;
      if (response.status === 504 && code === "preview_trace_timeout") {
        const details = record(body?.details);
        const range = traceRange(details?.range) ?? input.query.range;
        const retryRangeValue = details?.retryRange;
        const retryRange =
          retryRangeValue === null
            ? null
            : traceRange(retryRangeValue) ?? narrowerPreviewTraceRange(range);
        throw new PreviewTraceQueryTimeoutError(range, null, retryRange);
      }
      if (
        (response.status === 409 && code === "contract-mismatch") ||
        (response.status === 404 && code === "not-found")
      ) {
        throw new PreviewRuntimeIdentityChangedError(
          typeof body?.error === "string"
            ? body.error
            : "preview trace generation changed",
        );
      }
      throw new PreviewTraceTransportError(
        typeof body?.error === "string"
          ? body.error
          : `preview trace broker failed (HTTP ${response.status})`,
      );
    }
    const receiptIdentity = parseIdentity(body?.identity);
    const result = record(body?.result);
    if (
      body?.ok !== true ||
      !sameIdentity(receiptIdentity, identity) ||
      !result ||
      !Array.isArray(result.traces) ||
      !Array.isArray(result.services) ||
      result.services.some((service) => typeof service !== "string") ||
      typeof result.observedAt !== "string"
    ) {
      throw new PreviewTraceTransportError(
        "preview trace broker returned an invalid receipt",
      );
    }
    return {
      identity: receiptIdentity,
      traces: result.traces.map(parseTrace),
      services: result.services as string[],
      observedAt: result.observedAt,
    };
  }
}
