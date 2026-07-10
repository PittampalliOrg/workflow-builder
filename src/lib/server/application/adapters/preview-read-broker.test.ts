import { describe, expect, it, vi } from "vitest";
import {
  HmacPreviewControlCapabilityMintAdapter,
  HttpPreviewReadBrokerAdapter,
} from "$lib/server/application/adapters/preview-read-broker";
import {
  derivePreviewControlCapability,
  PREVIEW_CAPABILITY_PURPOSES,
} from "$lib/server/preview-control-capability";

const target = {
  name: "feature-one",
  url: "https://caller-controlled.example.test",
  pool: null,
  identity: {
    previewName: "feature-one",
    environmentRequestId: "request-1",
    environmentPlatformRevision: "a".repeat(40),
    environmentSourceRevision: "b".repeat(40),
    catalogDigest: `sha256:${"d".repeat(64)}` as const,
  },
};

describe("central preview read client", () => {
  it("sends only a named command and dedicated broker credential", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            kind: "list-executions",
            result: { ok: true, data: { executions: [], total: 0 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new HttpPreviewReadBrokerAdapter({
      baseUrl: () => "http://preview-control-broker:3000/",
      token: () => "broker-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.listExecutions({ target, limit: 25, status: null }),
    ).resolves.toEqual({ ok: true, data: { executions: [], total: 0 } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "http://preview-control-broker:3000/api/internal/preview-control/read",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("x-preview-control-broker-token")).toBe("broker-token");
    expect(headers.get("x-internal-token")).toBeNull();
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      previewName: "feature-one",
      identity: target.identity,
      command: { kind: "list-executions", limit: 25, status: null },
    });
    expect(JSON.stringify(body)).not.toContain(target.url);
  });

  it("preserves bounded binary file responses", async () => {
    const adapter = new HttpPreviewReadBrokerAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
      fetchImpl: vi.fn(
        async () =>
          new Response("bundle", {
            status: 200,
            headers: {
              "content-type": "application/gzip",
              "x-preview-read-ok": "true",
            },
          }),
      ) as typeof fetch,
    });
    const result = await adapter.fetchFileContent({
      target,
      fileId: "file-1",
      maxBytes: 1024,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.bytes.toString()).toBe("bundle");
      expect(result.data.contentType).toBe("application/gzip");
    }
  });

  it("fails closed before fetch when exact generation authority is absent", async () => {
    const fetchImpl = vi.fn();
    const adapter = new HttpPreviewReadBrokerAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      adapter.listExecutions({
        target: { name: target.name, url: target.url, pool: null },
        limit: 25,
        status: null,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "unauthorized" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("central preview read capability mint", () => {
  it("derives the control-purpose leaf, never the runtime leaf", () => {
    const root = "a".repeat(64);
    const identity = {
      previewName: "feature-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "b".repeat(40),
      environmentSourceRevision: "c".repeat(40),
      catalogDigest: `sha256:${"d".repeat(64)}` as const,
    };
    const adapter = new HmacPreviewControlCapabilityMintAdapter(() => root);
    expect(adapter.mintControl(identity)).toBe(
      derivePreviewControlCapability(
        root,
        identity,
        PREVIEW_CAPABILITY_PURPOSES.controlToken,
      ),
    );
    expect(adapter.mintControl(identity)).not.toBe(
      derivePreviewControlCapability(
        root,
        identity,
        PREVIEW_CAPABILITY_PURPOSES.runtimeToken,
      ),
    );
  });
});
