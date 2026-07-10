import { describe, expect, it } from "vitest";
import {
  BoundedJsonBodyError,
  readBoundedJsonObject,
} from "./bounded-json-body";

const MAX_BYTES = 64;

function streamingRequest(chunks: readonly Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://broker/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readBoundedJsonObject", () => {
  it("rejects a declared oversized body before consuming it", async () => {
    const request = new Request("http://broker/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_BYTES + 1),
      },
      body: "{}",
    });

    await expect(
      readBoundedJsonObject(request, MAX_BYTES),
    ).rejects.toMatchObject({
      name: "BoundedJsonBodyError",
      code: "too-large",
      statusCode: 413,
    } satisfies Partial<BoundedJsonBodyError>);
    expect(request.bodyUsed).toBe(false);
  });

  it("rejects a chunked body as soon as its observed bytes exceed the bound", async () => {
    const request = streamingRequest([
      new TextEncoder().encode(`{"value":"${"a".repeat(50)}`),
      new TextEncoder().encode(`${"b".repeat(50)}"}`),
    ]);

    await expect(
      readBoundedJsonObject(request, MAX_BYTES),
    ).rejects.toMatchObject({
      name: "BoundedJsonBodyError",
      code: "too-large",
      statusCode: 413,
    } satisfies Partial<BoundedJsonBodyError>);
  });

  it("rejects a declared length that does not match the completed stream", async () => {
    const request = new Request("http://broker/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "10",
      },
      body: "{}",
    });

    await expect(
      readBoundedJsonObject(request, MAX_BYTES),
    ).rejects.toMatchObject({
      code: "incomplete",
      statusCode: 400,
    } satisfies Partial<BoundedJsonBodyError>);
  });

  it("requires application/json and a top-level object", async () => {
    const text = new Request("http://broker/internal", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(readBoundedJsonObject(text, MAX_BYTES)).rejects.toMatchObject({
      code: "unsupported-media-type",
      statusCode: 415,
    } satisfies Partial<BoundedJsonBodyError>);

    const array = new Request("http://broker/internal", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: "[]",
    });
    await expect(readBoundedJsonObject(array, MAX_BYTES)).rejects.toMatchObject(
      {
        code: "invalid-json",
        statusCode: 400,
      } satisfies Partial<BoundedJsonBodyError>,
    );
  });
});
