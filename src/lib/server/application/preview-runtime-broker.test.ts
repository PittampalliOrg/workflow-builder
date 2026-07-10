import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewRuntimeBrokerService } from "$lib/server/application/preview-runtime-broker";

const identity = Object.freeze({
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}` as const,
});

function harness(
  input: { capability?: boolean; maxConcurrency?: number } = {},
) {
  const audit = vi.fn();
  const authority = {
    authorizeRuntime: vi.fn(async () => ({
      previewName: identity.previewName,
      requestId: identity.environmentRequestId,
      owner: "admin-1",
      platformRevision: identity.environmentPlatformRevision as never,
      sourceRevision: identity.environmentSourceRevision as never,
      catalogDigest: identity.catalogDigest,
      services: ["workflow-builder", "workflow-orchestrator"],
    })),
  };
  const upstream = {
    complete: vi.fn(async () => ({
      status: 200,
      contentType: "application/json",
      requestId: "upstream-1",
      body: null,
    })),
  };
  const service = new ApplicationPreviewRuntimeBrokerService({
    authority,
    capabilities: { verify: vi.fn(() => input.capability ?? true) },
    catalog: {
      currentDigest: () => identity.catalogDigest,
      listPreviewNativeServices: () => [
        "workflow-builder",
        "workflow-orchestrator",
      ],
      assertPreviewNativeServices: (services) => services,
    },
    upstream,
    allowedModels: ["deepseek-v4-pro"],
    maxConcurrency: input.maxConcurrency ?? 2,
    audit,
  });
  return { service, authority, upstream, audit };
}

const request = {
  identity,
  capability: "d".repeat(64),
  payload: {
    model: "deepseek-v4-pro",
    messages: [{ role: "user", content: "secret prompt" }],
    stream: true,
  },
};

describe("preview runtime broker application policy", () => {
  it("rejects a mismatched capability before physical inspection", async () => {
    const h = harness({ capability: false });
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(h.authority.authorizeRuntime).not.toHaveBeenCalled();
    expect(h.upstream.complete).not.toHaveBeenCalled();
  });

  it("requires an allowlisted model and valid chat shape", async () => {
    const h = harness();
    await expect(
      h.service.complete({
        ...request,
        payload: { ...request.payload, model: "attacker-model" },
      }),
    ).rejects.toMatchObject({ code: "model-forbidden" });
    await expect(
      h.service.complete({ ...request, payload: { model: "deepseek-v4-pro" } }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(h.authority.authorizeRuntime).not.toHaveBeenCalled();
  });

  it("re-authorizes the exact tuple and full preview-native baseline", async () => {
    const h = harness();
    await expect(h.service.complete(request)).resolves.toMatchObject({
      status: 200,
    });
    expect(h.authority.authorizeRuntime).toHaveBeenCalledWith({
      previewName: identity.previewName,
      environmentRequestId: identity.environmentRequestId,
      environmentPlatformRevision: identity.environmentPlatformRevision,
      environmentSourceRevision: identity.environmentSourceRevision,
      catalogDigest: identity.catalogDigest,
      requiredServices: ["workflow-builder", "workflow-orchestrator"],
    });
    expect(h.upstream.complete).toHaveBeenCalledWith({
      identity,
      payload: request.payload,
    });
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret prompt");
  });

  it("bounds in-process concurrency", async () => {
    const h = harness({ maxConcurrency: 1 });
    let release!: () => void;
    h.upstream.complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              contentType: "application/json",
              requestId: "upstream-2",
              body: null,
            });
        }),
    );
    const first = h.service.complete(request);
    await vi.waitFor(() => expect(h.upstream.complete).toHaveBeenCalledOnce());
    await expect(h.service.complete(request)).rejects.toMatchObject({
      code: "capacity",
    });
    release();
    await first;
  });
});
