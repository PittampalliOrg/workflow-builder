import { describe, expect, it, vi } from "vitest";
import {
  operationNameForSpan,
  requestPayloadForSpan,
  responsePayloadForSpan,
  routeForSpan,
  shouldCaptureApiIo,
} from "./api-io";

describe("api io capture helpers", () => {
  it("captures GET API path and query without reading a body", async () => {
    const url = new URL(
      "https://app.test/api/workflows/executions?include=summary&tag=a&tag=b",
    );
    const request = new Request(url, { method: "GET" });

    expect(shouldCaptureApiIo(url, request.method)).toBe(true);
    await expect(requestPayloadForSpan(request, url)).resolves.toEqual({
      method: "GET",
      path: "/api/workflows/executions",
      query: { include: "summary", tag: ["a", "b"] },
    });
  });

  it("parses JSON request and response bodies", async () => {
    const url = new URL("https://app.test/api/workflows/abc/execute");
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "render a proof" }),
    });
    const response = Response.json(
      { ok: true, executionId: "exec_1" },
      { status: 201 },
    );

    await expect(requestPayloadForSpan(request, url)).resolves.toEqual({
      method: "POST",
      path: "/api/workflows/abc/execute",
      query: {},
      body: { prompt: "render a proof" },
    });
    await expect(responsePayloadForSpan(response, url)).resolves.toMatchObject({
      status: 201,
      body: { ok: true, executionId: "exec_1" },
    });
  });

  it("omits browser screenshot response pixels without cloning the body", async () => {
    const url = new URL(
      "https://app.test/api/internal/observability/executions/execution-1/browser-artifacts/screenshot?storageRef=screenshots%2Fframe.png",
    );
    const pixels = "iVBORw0KGgo-sensitive-pixels";
    const response = Response.json({
      storageRef: "screenshots/frame.png",
      contentType: "image/png",
      payloadBase64: pixels,
      sizeBytes: 20,
    });
    const clone = vi.spyOn(response, "clone");

    const captured = await responsePayloadForSpan(response, url);

    expect(captured).toEqual({
      status: 200,
      contentType: "application/json",
      body: "[browser screenshot payload omitted]",
    });
    expect(clone).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).not.toContain(pixels);
  });

  it("retains screenshot endpoint error evidence", async () => {
    const url = new URL(
      "https://app.test/api/internal/observability/executions/execution-1/browser-artifacts/screenshot",
    );
    const response = Response.json(
      { error: "storageRef is required" },
      { status: 400 },
    );
    const clone = vi.spyOn(response, "clone");

    await expect(responsePayloadForSpan(response, url)).resolves.toEqual({
      status: 400,
      contentType: "application/json",
      body: { error: "storageRef is required" },
    });
    expect(clone).toHaveBeenCalledOnce();
  });

  it("omits successful binary responses without cloning the body", async () => {
    const url = new URL(
      "https://app.test/api/internal/preview-control/environment/workspace-source",
    );
    const response = new Response(new Uint8Array([0, 1, 2, 3]), {
      headers: { "content-type": "application/vnd.git.bundle" },
    });
    const clone = vi.spyOn(response, "clone");

    await expect(responsePayloadForSpan(response, url)).resolves.toEqual({
      status: 200,
      contentType: "application/vnd.git.bundle",
      body: "[non-text response body]",
    });
    expect(clone).not.toHaveBeenCalled();
  });

  it("retains body inspection for successful responses without a content type", async () => {
    const url = new URL("https://app.test/api/workflows/abc/status");
    const response = new Response(
      new TextEncoder().encode("untyped response body"),
    );
    const clone = vi.spyOn(response, "clone");

    await expect(responsePayloadForSpan(response, url)).resolves.toEqual({
      status: 200,
      contentType: undefined,
      body: "[non-text response body]",
    });
    expect(clone).toHaveBeenCalledOnce();
  });

  it("omits browser artifact upload pixels without cloning the body", async () => {
    const url = new URL("https://app.test/api/internal/browser-artifacts");
    const pixels = "iVBORw0KGgo-sensitive-upload-pixels";
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executionId: "execution-1",
        screenshots: [{ payloadBase64: pixels, contentType: "image/png" }],
      }),
    });
    const clone = vi.spyOn(request, "clone");

    const captured = await requestPayloadForSpan(request, url);

    expect(captured).toEqual({
      method: "POST",
      path: "/api/internal/browser-artifacts",
      query: {},
      body: "[browser artifact payload omitted]",
    });
    expect(clone).not.toHaveBeenCalled();
    expect(JSON.stringify(captured)).not.toContain(pixels);
  });

  it("captures SvelteKit remote function payloads without raw payload query noise", async () => {
    const payload = Buffer.from(JSON.stringify(["ryzen"])).toString(
      "base64url",
    );
    const url = new URL(
      `https://app.test/_app/remote/1muz71w/getCapacityTrends?payload=${payload}&refresh=1`,
    );
    const request = new Request(url, { method: "GET" });

    expect(shouldCaptureApiIo(url, request.method)).toBe(true);
    expect(routeForSpan(url)).toBe("/_app/remote/:id/getCapacityTrends");
    expect(operationNameForSpan(request.method, url)).toBe(
      "workflow-builder.remote GET getCapacityTrends",
    );
    await expect(requestPayloadForSpan(request, url)).resolves.toEqual({
      method: "GET",
      path: "/_app/remote/:id/getCapacityTrends",
      query: { refresh: "1" },
      remoteCall: "getCapacityTrends",
      payload: ["ryzen"],
    });
  });

  it("does not consume event-stream responses", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: heartbeat\\n\\n"));
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });

    await expect(
      responsePayloadForSpan(
        response,
        new URL("https://app.test/api/workflows/executions/stream"),
      ),
    ).resolves.toEqual({
      status: 200,
      contentType: "text/event-stream",
      body: "[streaming response omitted]",
    });
    expect(response.bodyUsed).toBe(false);
  });
});
