import { describe, expect, it } from "vitest";
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
    await expect(responsePayloadForSpan(response)).resolves.toMatchObject({
      status: 201,
      body: { ok: true, executionId: "exec_1" },
    });
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

    await expect(responsePayloadForSpan(response)).resolves.toEqual({
      status: 200,
      contentType: "text/event-stream",
      body: "[streaming response omitted]",
    });
    expect(response.bodyUsed).toBe(false);
  });
});
