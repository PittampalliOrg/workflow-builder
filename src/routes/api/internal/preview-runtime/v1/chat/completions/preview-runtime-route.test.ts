import { beforeEach, describe, expect, it, vi } from "vitest";

const complete = vi.hoisted(() =>
  vi.fn(async () => ({
    status: 200,
    contentType: "application/json",
    requestId: "gateway-1",
    body: new Response('{"id":"completion-1"}').body,
  })),
);

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({ previewRuntimeBroker: { complete } }),
}));

import { POST } from "./+server";
import { PreviewRuntimeBrokerError } from "$lib/server/application/preview-runtime-broker";

const identityHeaders = {
  "x-preview-runtime-capability": "d".repeat(64),
  "x-preview-environment-name": "feature-one",
  "x-preview-environment-request-id": "request-1",
  "x-preview-environment-platform-revision": "a".repeat(40),
  "x-preview-environment-source-revision": "b".repeat(40),
  "x-preview-environment-catalog-digest": `sha256:${"c".repeat(64)}`,
};

function request(
  body: unknown = {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "hello" }],
  },
  headers: Record<string, string> = {},
) {
  return new Request(
    "http://broker/api/internal/preview-runtime/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...identityHeaders,
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

describe("preview runtime route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delegates only the tuple, leaf capability, and JSON payload", async () => {
    const response = (await POST({ request: request() } as never)) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "completion-1" });
    expect(response.headers.get("x-upstream-request-id")).toBe("gateway-1");
    expect(complete).toHaveBeenCalledWith({
      identity: {
        previewName: "feature-one",
        environmentRequestId: "request-1",
        environmentPlatformRevision: "a".repeat(40),
        environmentSourceRevision: "b".repeat(40),
        catalogDigest: `sha256:${"c".repeat(64)}`,
      },
      capability: "d".repeat(64),
      payload: {
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hello" }],
      },
    });
  });

  it("rejects an incomplete identity before broker composition", async () => {
    const response = (await POST({
      request: request(undefined, { "x-preview-environment-request-id": "" }),
    } as never)) as Response;
    expect(response.status).toBe(400);
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body before reading it", async () => {
    const response = (await POST({
      request: request(undefined, {
        "content-length": String(524_288 + 1),
      }),
    } as never)) as Response;
    expect(response.status).toBe(413);
    expect(complete).not.toHaveBeenCalled();
  });

  it("maps exhausted and unavailable distributed budgets without leaking causes", async () => {
    complete.mockRejectedValueOnce(
      new PreviewRuntimeBrokerError(
        "budget-exhausted",
        "preview runtime budget is exhausted",
        "minute-token-limit",
      ),
    );
    const exhausted = (await POST({ request: request() } as never)) as Response;
    expect(exhausted.status).toBe(429);
    await expect(exhausted.json()).resolves.toEqual({
      error: "preview runtime budget is exhausted",
      code: "budget-exhausted",
      reason: "minute-token-limit",
    });

    complete.mockRejectedValueOnce(
      new PreviewRuntimeBrokerError(
        "budget-unavailable",
        "preview runtime budget authority is unavailable",
      ),
    );
    const unavailable = (await POST({
      request: request(),
    } as never)) as Response;
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toEqual({
      error: "preview runtime budget authority is unavailable",
      code: "budget-unavailable",
    });
  });
});
