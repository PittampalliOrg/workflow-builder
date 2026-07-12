import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewBffDevPodGateway } from "$lib/server/application/adapters/pr-previews";
import { RetryableDevPreviewActivationError } from "$lib/server/application/ports/dev-preview-provisioner";

const mocks = vi.hoisted(() => {
  const identity = {
    previewName: "pr-42",
    environmentRequestId: "request-42",
    environmentPlatformRevision: "b".repeat(40),
    environmentSourceRevision: "c".repeat(40),
    catalogDigest: `sha256:${"a".repeat(64)}`,
  };
  return {
    identity,
    adopt: vi.fn(),
    requireCapability: vi.fn(),
  };
});

vi.mock("$env/dynamic/private", () => ({
  env: {
    PREVIEW_ENVIRONMENT_SERVICES_JSON: JSON.stringify(["workflow-builder"]),
    PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN: "f".repeat(64),
  },
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewLocalControlIdentity: { current: () => mocks.identity },
    previewPrAdoption: { adopt: mocks.adopt },
  }),
}));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requireCapability,
}));

import { POST } from "../../../../routes/api/internal/preview-control/pr-adoption/+server";

const requestBody = {
  name: mocks.identity.previewName,
  requestId: mocks.identity.environmentRequestId,
  platformRevision: mocks.identity.environmentPlatformRevision,
  sourceRevision: mocks.identity.environmentSourceRevision,
  catalogDigest: mocks.identity.catalogDigest,
  services: ["workflow-builder"],
  origin: "https://wfb-pr-42.tail286401.ts.net",
  waitReadySeconds: 300,
};

function routeRequest(body = requestBody): { request: Request } {
  return {
    request: new Request(
      "http://preview-bff/api/internal/preview-control/pr-adoption",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  };
}

function activeReceipt() {
  return {
    executionId: "pr-adopt-request-42",
    services: [
      {
        service: "workflow-builder",
        ok: true,
        info: {
          podIP: "10.0.0.10",
          syncPort: 3000,
          syncCapability: "1".repeat(64),
        },
      },
    ],
    ok: true,
    complete: true,
    pending: false,
    activationPhase: "active" as const,
    batchId: "batch-request-42",
  };
}

function routeFetch() {
  return vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    return (await POST(
      routeRequest(JSON.parse(String(init?.body))) as never,
    )) as Response;
  });
}

describe("PR adoption retry integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replays the exact gateway request after route-level activation uncertainty", async () => {
    mocks.adopt
      .mockRejectedValueOnce(
        new RetryableDevPreviewActivationError(
          "malformed SEA activation receipt",
        ),
      )
      .mockResolvedValueOnce(activeReceipt());
    const fetch = routeFetch();
    let now = 0;
    const gateway = new PreviewBffDevPodGateway({
      fetch,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      now: () => now,
      resolveBaseUrl: async () => "http://preview-bff",
      activationTimeoutMs: 100,
      retryDelayMs: 10,
    });

    await expect(
      gateway.provision({
        previewUrl: requestBody.origin,
        alias: requestBody.name,
        services: requestBody.services,
        syncToken: "unused",
        requestId: requestBody.requestId,
        platformRevision: requestBody.platformRevision,
        sourceRevision: requestBody.sourceRevision,
        catalogDigest: requestBody.catalogDigest as `sha256:${string}`,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ service: "workflow-builder", ok: true }),
    ]);
    expect(mocks.adopt).toHaveBeenCalledTimes(2);
    expect(mocks.adopt.mock.calls[1]?.[0]).toEqual(mocks.adopt.mock.calls[0]?.[0]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
  });

  it("keeps explicit activation rejection terminal and one-shot", async () => {
    mocks.adopt.mockResolvedValueOnce({
      executionId: "pr-adopt-request-42",
      services: [],
      ok: false,
      complete: false,
      pending: false,
      activationPhase: "failed",
    });
    const fetch = routeFetch();
    const gateway = new PreviewBffDevPodGateway({
      fetch,
      sleep: async () => undefined,
      now: () => 0,
      resolveBaseUrl: async () => "http://preview-bff",
      activationTimeoutMs: 100,
      retryDelayMs: 10,
    });

    await expect(
      gateway.provision({
        previewUrl: requestBody.origin,
        alias: requestBody.name,
        services: requestBody.services,
        syncToken: "unused",
        requestId: requestBody.requestId,
        platformRevision: requestBody.platformRevision,
        sourceRevision: requestBody.sourceRevision,
        catalogDigest: requestBody.catalogDigest as `sha256:${string}`,
      }),
    ).rejects.toThrow("preview dev-pod provision failed (HTTP 409)");
    expect(mocks.adopt).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
