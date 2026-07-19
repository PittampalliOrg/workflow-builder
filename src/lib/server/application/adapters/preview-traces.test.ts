import { describe, expect, it, vi } from "vitest";
import type {
  PreviewControlIdentity,
  PreviewTraceQuery,
} from "$lib/server/application/ports";
import {
  ClickHousePreviewTraceQueryAdapter,
  HttpPreviewTraceQueryAdapter,
} from "$lib/server/application/adapters/preview-traces";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";

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
    const adapter = new ClickHousePreviewTraceQueryAdapter(
      async (statement) => {
        sql.push(statement);
        return [];
      },
      () => new Date("2026-07-13T12:00:00.000Z"),
    );

    await adapter.query({ identity, query });

    expect(sql).toHaveLength(2);
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
});
