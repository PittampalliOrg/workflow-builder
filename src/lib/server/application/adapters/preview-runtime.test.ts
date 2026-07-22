import { describe, expect, it, vi } from "vitest";
import {
  HmacPreviewRuntimeCapabilityAdapter,
  HttpPreviewRuntimeUpstreamAdapter,
  MAX_PREVIEW_RUNTIME_UPSTREAM_TIMEOUT_MS,
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
  it("clamps long preview model calls to the 30-minute upstream ceiling", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const adapter = new HttpPreviewRuntimeUpstreamAdapter({
        url: () => "https://api.z.ai/api/paas/v4/chat/completions",
        token: () => "provider-token",
        timeoutMs: 9_000_000,
        fetchImpl: vi.fn(
          async () =>
            new Response('{"id":"completion-1"}', {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
        ) as typeof fetch,
      });

      await adapter.complete({
        identity,
        payload: {
          model: "kimi-k3",
          messages: [{ role: "user", content: "hi" }],
        },
      });

      expect(MAX_PREVIEW_RUNTIME_UPSTREAM_TIMEOUT_MS).toBe(1_800_000);
      expect(timeout).toHaveBeenCalledWith(1_800_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("uses the exact trusted URL and injects only central credentials", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"completion-1"}', {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "zai-1",
          },
        }),
    );
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      url: () => "https://api.z.ai/api/paas/v4/chat/completions",
      token: () => "provider-token",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await adapter.complete({
      identity,
      payload: {
        model: "glm-5.2",
        messages: [{ role: "user", content: "hello" }],
        url: "https://attacker.example/v1/chat/completions",
      },
    });
    expect(result).toMatchObject({
      status: 200,
      contentType: "application/json",
      requestId: "zai-1",
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "glm-5.2",
      url: "https://attacker.example/v1/chat/completions",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer provider-token");
    expect(headers.get("accept-language")).toBe("en-US,en");
    expect(headers.get("user-agent")).toBe(
      "workflow-builder-preview-runtime/1.0",
    );
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("proxy-authorization")).toBeNull();
    expect(headers.get("x-preview-environment-request-id")).toBe("request-1");
  });

  it("preserves a JSON upstream error that omits content-type", async () => {
    const upstreamBody = new TextEncoder().encode(
      JSON.stringify({
        error: {
          code: "1305",
          message: "The service may be temporarily overloaded",
        },
      }),
    );
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      url: () => "https://api.z.ai/api/paas/v4/chat/completions",
      token: () => "provider-token",
      fetchImpl: vi.fn(async () =>
        new Response(upstreamBody, {
          status: 429,
          headers: { "retry-after": "3" },
        }),
      ) as typeof fetch,
    });

    const result = await adapter.complete({
      identity,
      payload: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });

    expect(result).toMatchObject({
      status: 429,
      contentType: "application/json",
      retryAfter: "3",
    });
    await expect(new Response(result.body).json()).resolves.toEqual({
      error: {
        code: "1305",
        message: "The service may be temporarily overloaded",
      },
    });
  });

  it("sanitizes a non-JSON upstream error while preserving its status", async () => {
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      url: () => "https://api.z.ai/api/paas/v4/chat/completions",
      token: () => "provider-token",
      fetchImpl: vi.fn(async () =>
        new Response("<html>edge failure</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      ) as typeof fetch,
    });

    const result = await adapter.complete({
      identity,
      payload: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] },
    });

    expect(result).toMatchObject({ status: 503, contentType: "application/json" });
    await expect(new Response(result.body).json()).resolves.toEqual({
      error: {
        message: "preview runtime upstream returned HTTP 503",
        type: "upstream_error",
        code: "upstream_http_503",
      },
    });
  });

  it("rejects an unsupported content type on a successful response", async () => {
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      url: () => "https://api.z.ai/api/paas/v4/chat/completions",
      token: () => "provider-token",
      fetchImpl: vi.fn(async () =>
        new Response("not a completion", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ) as typeof fetch,
    });

    await expect(
      adapter.complete({
        identity,
        payload: { model: "glm-5.2", messages: [{ role: "user", content: "hi" }] },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([
    "ftp://gateway.example/v1/chat/completions",
    "https://user:pass@gateway.example/v1/chat/completions",
    "https://gateway.example/v1/chat/completions?target=attacker",
    "https://gateway.example/v1/chat/completions#fragment",
    "https://gateway.example/v1",
  ])("rejects an unsafe or non-completion upstream URL: %s", async (url) => {
    const adapter = new HttpPreviewRuntimeUpstreamAdapter({
      url: () => url,
      token: () => "provider-token",
    });
    await expect(
      adapter.complete({ identity, payload: { model: "x", messages: [{}] } }),
    ).rejects.toMatchObject({ code: "configuration" });
  });
});
