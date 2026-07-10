import { describe, expect, it, vi } from "vitest";
import {
  HmacPreviewRuntimeCapabilityAdapter,
  HttpPreviewRuntimeUpstreamAdapter,
} from "$lib/server/application/adapters/preview-runtime";
import {
  derivePreviewControlCapability,
  PREVIEW_CAPABILITY_PURPOSES,
} from "$lib/server/preview-control-capability";

const identity = Object.freeze({
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
});

describe("preview runtime capability adapter", () => {
  it("accepts only the runtime-purpose leaf for the exact tuple", () => {
    const root = "d".repeat(64);
    const adapter = new HmacPreviewRuntimeCapabilityAdapter(() => root);
    const runtime = derivePreviewControlCapability(
      root,
      identity,
      PREVIEW_CAPABILITY_PURPOSES.runtimeToken,
    );
    const control = derivePreviewControlCapability(
      root,
      identity,
      PREVIEW_CAPABILITY_PURPOSES.controlToken,
    );
    expect(adapter.verify({ identity, capability: runtime })).toBe(true);
    expect(adapter.verify({ identity, capability: control })).toBe(false);
    expect(
      adapter.verify({
        identity: { ...identity, environmentRequestId: "request-2" },
        capability: runtime,
      }),
    ).toBe(false);
  });
});

describe("preview runtime HTTP adapter", () => {
  it("uses the fixed path and injects only central credentials", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"completion-1"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "gateway-1",
          },
        }),
    );
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      baseUrl: () => "http://gateway.example:7000/v1",
      token: () => "provider-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await adapter.complete({
      identity,
      payload: {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
      },
    });
    expect(result).toMatchObject({
      status: 200,
      contentType: "application/json",
      requestId: "gateway-1",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://gateway.example:7000/v1/chat/completions");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-preview-environment-request-id")).toBe("request-1");
  });

  it("rejects caller-like URL authority outside the configured /v1 base", async () => {
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      baseUrl: () => "https://user:pass@gateway.example/other?target=attacker",
      token: () => "provider-token",
    });
    await expect(
      adapter.complete({ identity, payload: { model: "x", messages: [{}] } }),
    ).rejects.toMatchObject({ code: "configuration" });
  });
});
