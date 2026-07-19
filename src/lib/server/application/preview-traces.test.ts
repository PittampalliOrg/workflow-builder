import { describe, expect, it, vi } from "vitest";
import type {
  PreviewControlIdentity,
  PreviewTraceQueryPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";
import {
  ApplicationPreviewTraceBrokerService,
  ApplicationPreviewTraceService,
  PreviewTraceQueryError,
  normalizePreviewTraceQuery,
} from "$lib/server/application/preview-traces";

const identity: PreviewControlIdentity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};

const preview = {
  name: identity.previewName,
  platformRevision: identity.environmentPlatformRevision,
  sourceRevision: identity.environmentSourceRevision,
  catalogDigest: identity.catalogDigest,
  provenance: { requestId: identity.environmentRequestId },
} as unknown as VclusterPreviewRecord;

function queryPort(
  overrides: Partial<PreviewControlIdentity> = {},
): PreviewTraceQueryPort {
  return {
    query: vi.fn(async ({ query }) => ({
      identity: { ...identity, ...overrides },
      traces: [],
      services: [],
      observedAt: "2026-07-13T12:00:00.000Z",
      query,
    })) as never,
  };
}

describe("preview trace query application boundary", () => {
  it("normalizes bounded filters and rejects unknown fields", () => {
    expect(
      normalizePreviewTraceQuery({ range: "15m", status: "error", limit: 10 }),
    ).toEqual({
      range: "15m",
      status: "error",
      service: null,
      search: null,
      limit: 10,
    });
    expect(normalizePreviewTraceQuery({ range: "7d" }).range).toBe("7d");
    expect(() => normalizePreviewTraceQuery({ sql: "select 1" })).toThrow(
      PreviewTraceQueryError,
    );
    expect(() => normalizePreviewTraceQuery({ limit: 101 })).toThrow(
      PreviewTraceQueryError,
    );
  });

  it("authorizes the actor and queries only the identity from that record", async () => {
    const access = {
      authorize: vi.fn(async () => ({
        preview,
        ownerId: "user-1",
        actorIsOwner: true,
        actorIsPlatformAdmin: false,
      })),
    };
    const traces = queryPort();
    const service = new ApplicationPreviewTraceService({ access, traces });

    await service.list({
      name: identity.previewName,
      actorUserId: "user-1",
      query: { range: "1h" },
    });

    expect(access.authorize).toHaveBeenCalledWith({
      name: identity.previewName,
      actorUserId: "user-1",
    });
    expect(traces.query).toHaveBeenCalledWith({
      identity,
      query: {
        range: "1h",
        status: "all",
        service: null,
        search: null,
        limit: 25,
      },
    });
  });

  it("fails closed when the driven adapter returns another generation", async () => {
    const service = new ApplicationPreviewTraceService({
      access: { authorize: vi.fn(async () => ({ preview })) } as never,
      traces: queryPort({ environmentRequestId: "request-2" }),
    });

    await expect(
      service.list({
        name: identity.previewName,
        actorUserId: "user-1",
        query: {},
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it("keeps physical source authority ahead of the telemetry adapter", async () => {
    const order: string[] = [];
    const authority = {
      authorizeTraceTuple: vi.fn(async () => {
        order.push("authority");
        return {};
      }),
    };
    const traces = {
      query: vi.fn(async () => {
        order.push("query");
        return {
          identity,
          traces: [],
          services: [],
          observedAt: "2026-07-13T12:00:00.000Z",
        };
      }),
    };
    const broker = new ApplicationPreviewTraceBrokerService({
      authority: authority as never,
      traces,
    });

    await broker.list({ identity, query: {} });

    expect(order).toEqual(["authority", "query"]);
  });
});
