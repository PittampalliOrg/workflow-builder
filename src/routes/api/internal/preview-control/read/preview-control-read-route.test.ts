import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewControlBroker: vi.fn(),
  execute: vi.fn(async () => ({
    kind: "list-executions",
    result: { ok: true, data: { executions: [], total: 0 } },
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requirePreviewControlBroker,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewReadBroker: { execute: mocks.execute },
  }),
}));

import { POST } from "./+server";

const identity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}`,
};

function event(body: unknown) {
  return {
    request: new Request("http://broker/api/internal/preview-control/read", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-preview-control-broker-token": "broker-token",
      },
      body: JSON.stringify(body),
    }),
  };
}

describe("preview control read route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts only the narrow broker command", async () => {
    const body = {
      previewName: "feature-one",
      identity,
      command: { kind: "list-executions", limit: 25, status: null },
    };
    const response = (await POST(event(body) as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith(body);
    await expect(response.json()).resolves.toMatchObject({
      kind: "list-executions",
      result: { ok: true },
    });
  });

  it("rejects caller-authored URLs and credentials", async () => {
    const response = (await POST(
      event({
        previewName: "feature-one",
        identity,
        url: "http://attacker",
        token: "secret",
        command: { kind: "list-executions", limit: 25, status: null },
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns fetched file bytes without JSON coercion", async () => {
    mocks.execute.mockResolvedValueOnce({
      kind: "fetch-file",
      result: {
        ok: true,
        data: { bytes: Buffer.from("bundle"), contentType: "application/gzip" },
      },
    } as never);
    const response = (await POST(
      event({
        previewName: "feature-one",
        identity,
        command: { kind: "fetch-file", fileId: "file-1", maxBytes: 1024 },
      }) as never,
    )) as Response;
    expect(response.headers.get("x-preview-read-ok")).toBe("true");
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("bundle");
  });
});
