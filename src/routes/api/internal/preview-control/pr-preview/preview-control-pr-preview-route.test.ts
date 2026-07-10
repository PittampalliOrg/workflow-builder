import { beforeEach, describe, expect, it, vi } from "vitest";

const HEAD = "a".repeat(40);
const mocks = vi.hoisted(() => ({
  requirePreviewControlBroker: vi.fn(),
  up: vi.fn(async () => ({
    prNumber: 42,
    alias: "pr-42",
    url: null,
    state: "provisioning",
    headSha: HEAD,
    services: ["workflow-builder"],
    error: null,
    verify: null,
    updatedAt: null,
  })),
  down: vi.fn(async () => ({ state: "down" })),
  status: vi.fn(async () => ({
    prNumber: 42,
    alias: "pr-42",
    url: null,
    state: "provisioning",
    headSha: HEAD,
    services: ["workflow-builder"],
    error: null,
    verify: null,
    updatedAt: null,
  })),
}));

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requirePreviewControlBroker,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    prPreviews: {
      up: mocks.up,
      down: mocks.down,
      status: mocks.status,
    },
  }),
}));

import { POST } from "./+server";

function event(body: Record<string, unknown>) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/pr-preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("physical preview-control PR command route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires broker auth and delegates the exact notification fields", async () => {
    const response = (await POST(
      event({
        action: "up",
        prNumber: 42,
        headSha: HEAD,
        verify: true,
      }) as never,
    )) as Response;
    expect(response.status).toBe(202);
    expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
    expect(mocks.up).toHaveBeenCalledWith({
      prNumber: 42,
      headSha: HEAD,
      verify: true,
    });
  });

  it("supports broker-owned status resumption", async () => {
    const response = (await POST(
      event({ action: "status", prNumber: 42 }) as never,
    )) as Response;
    expect(response.status).toBe(200);
    expect(mocks.status).toHaveBeenCalledWith(42);
  });

  it("rejects every caller-supplied authority field", async () => {
    const response = (await POST(
      event({
        action: "up",
        prNumber: 42,
        headSha: HEAD,
        services: ["workflow-builder"],
        platformRevision: "b".repeat(40),
        repository: "attacker/repo",
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.up).not.toHaveBeenCalled();
  });
});
