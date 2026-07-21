import { describe, expect, it, vi } from "vitest";
import type {
  PreviewControlIdentity,
  PreviewTraceQuery,
} from "$lib/server/application/ports";
import {
  ClickHousePreviewTraceQueryAdapter,
  DEFAULT_PREVIEW_TRACE_BROKER_TIMEOUT_MS,
  DEFAULT_PREVIEW_TRACE_QUERY_TIMEOUT_MS,
  HttpPreviewTraceQueryAdapter,
} from "$lib/server/application/adapters/preview-traces";
import {
  PreviewRuntimeIdentityChangedError,
  PreviewTraceQueryTimeoutError,
} from "$lib/server/application/ports";

const identity: PreviewControlIdentity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};
const query: PreviewTraceQuery = {
  range: "1h",
  status: "all",
  service: null,
  search: null,
  limit: 25,
};

describe("preview trace query adapters", () => {
  it("includes every tuple attribute in every ClickHouse query", async () => {
    const sql: string[] = [];
    const options: Array<{ timeoutMs?: number } | undefined> = [];
    const adapter = new ClickHousePreviewTraceQueryAdapter(
      async (statement, queryOptions) => {
        sql.push(statement);
        options.push(queryOptions);
        return [];
      },
      () => new Date("2026-07-13T12:00:00.000Z"),
    );

    await adapter.query({ identity, query });

    expect(sql).toHaveLength(2);
    expect(options).toEqual([
      { timeoutMs: DEFAULT_PREVIEW_TRACE_QUERY_TIMEOUT_MS },
      { timeoutMs: DEFAULT_PREVIEW_TRACE_QUERY_TIMEOUT_MS },
    ]);
    for (const statement of sql) {
      expect(statement).toContain(
        "ResourceAttributes['deployment.environment'] = 'dev-preview'",
      );
      expect(statement).toContain(
        "ResourceAttributes['preview.name'] = 'feature-one'",
      );
      expect(statement).toContain(
        "ResourceAttributes['preview.request_id'] = 'request-1'",
      );
      expect(statement).toContain(
        `ResourceAttributes['preview.platform_revision'] = '${"a".repeat(40)}'`,
      );
      expect(statement).toContain(
        `ResourceAttributes['preview.source_revision'] = '${"b".repeat(40)}'`,
      );
      expect(statement).toContain(
        `ResourceAttributes['preview.catalog_digest'] = 'sha256:${"c".repeat(64)}'`,
      );
    }
  });

  it("uses one trace-table scan and filters complete trace aggregates with HAVING", async () => {
    const sql: string[] = [];
    const adapter = new ClickHousePreviewTraceQueryAdapter(async (statement) => {
      sql.push(statement);
      return [];
    });

    await adapter.query({
      identity,
      query: {
        ...query,
        service: "workflow-builder",
        search: "can't render",
        status: "error",
      },
    });

    const traceSql = sql[0] ?? "";
    expect(traceSql.match(/FROM otel\.otel_traces/g)).toHaveLength(1);
    expect(traceSql).not.toContain("TraceId IN");
    expect(traceSql).toContain(
      "countIf(ServiceName = 'workflow-builder') > 0",
    );
    expect(traceSql).toContain(
      "countIf(positionCaseInsensitive(TraceId, 'can''t render') > 0 OR",
    );
    expect(traceSql).toContain("GROUP BY TraceId");
    expect(traceSql).toContain("HAVING countIf(");
    expect(traceSql).toContain("AND HasError = 1");
    expect(traceSql.indexOf("GROUP BY TraceId")).toBeLessThan(
      traceSql.indexOf("HAVING countIf("),
    );
  });

  it("supports the full seven-day preview retention window", async () => {
    const sql: string[] = [];
    const adapter = new ClickHousePreviewTraceQueryAdapter(async (statement) => {
      sql.push(statement);
      return [];
    });

    await adapter.query({ identity, query: { ...query, range: "7d" } });

    expect(sql).toHaveLength(2);
    expect(sql.every((statement) => statement.includes("INTERVAL 7 DAY"))).toBe(
      true,
    );
  });

  it("maps a physical query budget expiry to the typed retry contract", async () => {
    const timeout = Object.assign(new Error("query exceeded budget"), {
      name: "TimeoutError",
    });
    const adapter = new ClickHousePreviewTraceQueryAdapter(
      async () => {
        throw timeout;
      },
      undefined,
      { timeoutMs: 4_321 },
    );

    await expect(
      adapter.query({ identity, query: { ...query, range: "24h" } }),
    ).rejects.toMatchObject({
      name: "PreviewTraceQueryTimeoutError",
      code: "preview_trace_timeout",
      range: "24h",
      retryRange: "6h",
      timeoutMs: 4_321,
    } satisfies Partial<PreviewTraceQueryTimeoutError>);
  });

  it("uses the tuple leaf and rejects a mismatched broker receipt", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            identity: { ...identity, environmentRequestId: "request-2" },
            result: {
              traces: [],
              services: [],
              observedAt: "2026-07-13T12:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new HttpPreviewTraceQueryAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      credential: () => ({
        header: "X-Preview-Control-Capability",
        token: "d".repeat(64),
      }),
      fetch: fetchImpl as typeof fetch,
    });

    await expect(adapter.query({ identity, query })).rejects.toThrow(
      "invalid receipt",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://preview-control-broker:3000/api/internal/preview-control/environment/traces",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Preview-Control-Capability": "d".repeat(64),
        }),
      }),
    );
  });

  it("preserves a physical generation mismatch instead of collapsing it to availability", async () => {
    const adapter = new HttpPreviewTraceQueryAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      credential: () => ({
        header: "X-Preview-Control-Capability",
        token: "d".repeat(64),
      }),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              code: "contract-mismatch",
              error: "physical preview generation changed",
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    });

    await expect(adapter.query({ identity, query })).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
  });

  it("preserves the physical timeout contract across the broker transport", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const adapter = new HttpPreviewTraceQueryAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      credential: () => ({
        header: "X-Preview-Control-Capability",
        token: "d".repeat(64),
      }),
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              code: "preview_trace_timeout",
              error: "bounded trace query timed out",
              details: { range: "7d", retryRange: "24h" },
            }),
            { status: 504, headers: { "content-type": "application/json" } },
          ),
      ) as typeof fetch,
    });

    expect(DEFAULT_PREVIEW_TRACE_BROKER_TIMEOUT_MS).toBe(18_000);
    await expect(adapter.query({ identity, query })).rejects.toMatchObject({
      code: "preview_trace_timeout",
      range: "7d",
      retryRange: "24h",
      timeoutMs: null,
    } satisfies Partial<PreviewTraceQueryTimeoutError>);
    expect(timeout).toHaveBeenCalledWith(18_000);
    timeout.mockRestore();
  });

  it("maps an abort while consuming broker response bytes to a typed timeout", async () => {
    const adapter = new HttpPreviewTraceQueryAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      credential: () => ({
        header: "X-Preview-Control-Capability",
        token: "d".repeat(64),
      }),
      fetch: vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: async () => {
              throw Object.assign(new Error("response body aborted"), {
                name: "AbortError",
              });
            },
          }) as unknown as Response,
      ) as typeof fetch,
      timeoutMs: 4_321,
    });

    await expect(adapter.query({ identity, query })).rejects.toMatchObject({
      name: "PreviewTraceQueryTimeoutError",
      code: "preview_trace_timeout",
      range: "1h",
      retryRange: "15m",
      timeoutMs: 4_321,
    } satisfies Partial<PreviewTraceQueryTimeoutError>);
  });
});
