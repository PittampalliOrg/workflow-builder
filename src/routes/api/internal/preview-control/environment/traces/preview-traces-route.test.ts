import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
  validateBroker: vi.fn(() => false),
  requireCapability: vi.fn(),
  list: vi.fn(),
}));

vi.mock("$env/dynamic/private", () => ({ env: mocks.env }));
vi.mock("$lib/server/internal-auth", () => ({
  validatePreviewControlBrokerToken: mocks.validateBroker,
  requirePreviewControlCapability: mocks.requireCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({ previewTraceBroker: { list: mocks.list } }),
}));

import { POST } from "./+server";
import { PreviewTraceQueryTimeoutError } from "$lib/server/application/ports";

const identity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};

function event(body: unknown) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/environment/traces",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("physical preview trace route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "true";
    mocks.validateBroker.mockReturnValue(false);
    mocks.list.mockResolvedValue({
      identity,
      traces: [],
      services: ["workflow-builder"],
      observedAt: "2026-07-13T12:00:00.000Z",
    });
  });

  it("requires the exact tuple leaf and delegates a bounded query", async () => {
    const query = { range: "1h", status: "all", limit: 25 };
    const response = (await POST(
      event({ identity, query }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requireCapability).toHaveBeenCalledWith(
      expect.any(Request),
      identity,
    );
    expect(mocks.list).toHaveBeenCalledWith({ identity, query });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      identity,
      result: {
        traces: [],
        services: ["workflow-builder"],
        observedAt: "2026-07-13T12:00:00.000Z",
      },
    });
  });

  it("accepts the trusted central broker credential without weakening the tuple body", async () => {
    mocks.validateBroker.mockReturnValue(true);
    const response = (await POST(
      event({ identity, query: {} }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requireCapability).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledWith({ identity, query: {} });
  });

  it("rejects caller-authored SQL and credentials before application work", async () => {
    const response = (await POST(
      event({ identity, query: {}, sql: "select *", token: "secret" }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("is absent outside the physical broker deployment", async () => {
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "false";
    const response = (await POST(
      event({ identity, query: {} }) as never,
    )) as Response;

    expect(response.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("returns a typed timeout with a narrower-range retry contract", async () => {
    mocks.list.mockRejectedValueOnce(
      new PreviewTraceQueryTimeoutError("24h", 12_000),
    );

    const response = (await POST(
      event({ identity, query: { range: "24h" } }) as never,
    )) as Response;

    expect(response.status).toBe(504);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      code: "preview_trace_timeout",
      details: { range: "24h", retryRange: "6h" },
    });
  });
});
