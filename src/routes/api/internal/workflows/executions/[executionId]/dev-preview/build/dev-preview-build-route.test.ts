import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn(),
  resolveCanonicalExecutionId: vi.fn(async () => "exec-canonical"),
  getExecutionById: vi.fn(async () => ({
    id: "exec-canonical",
    userId: "admin-1",
  })),
  isPlatformAdmin: vi.fn(async () => true),
  buildAndReprovision: vi.fn(async () => ({
    ok: true,
    stage: "complete" as const,
    executionId: "exec-canonical",
    artifactId: "artifact-1",
    captureId: "capture-1",
    generation: "generation-1",
    branch: "preview-development-1",
    sourceRevision: "a".repeat(40),
    catalogDigest: `sha256:${"b".repeat(64)}`,
    services: [],
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewLocalControlIdentity: {
      current: () => ({
        previewName: "preview1",
        environmentRequestId: "request-1",
        environmentPlatformRevision: "a".repeat(40),
        environmentSourceRevision: "b".repeat(40),
        catalogDigest: `sha256:${"c".repeat(64)}`,
      }),
    },
    workflowData: {
      resolveCanonicalExecutionId: mocks.resolveCanonicalExecutionId,
      getExecutionById: mocks.getExecutionById,
      isPlatformAdmin: mocks.isPlatformAdmin,
    },
    previewDevelopmentBuild: {
      buildAndReprovision: mocks.buildAndReprovision,
    },
  }),
}));

import { POST } from "./+server";

function event(body: Record<string, unknown>) {
  return {
    params: { executionId: "dapr-instance-1" },
    request: new Request("http://localhost/internal/dev-preview/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

describe("dev-preview development build route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("binds to the canonical admin execution and forwards only the narrow command", async () => {
    const response = (await POST(
      event({
        services: ["workflow-builder", "function-router"],
        origin: "https://wfb-preview1.tail286401.ts.net",
        adopt: false,
      }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledOnce();
    expect(mocks.resolveCanonicalExecutionId).toHaveBeenCalledWith({
      executionId: "dapr-instance-1",
    });
    expect(mocks.buildAndReprovision).toHaveBeenCalledWith({
      executionId: "exec-canonical",
      services: ["workflow-builder", "function-router"],
      origin: "https://wfb-preview1.tail286401.ts.net",
      adopt: false,
    });
  });

  it("rejects caller attempts to control repository or build authority", async () => {
    const response = (await POST(
      event({
        services: ["workflow-builder"],
        origin: "https://wfb-preview1.tail286401.ts.net",
        adopt: true,
        repo: "attacker/repo",
        sourceRevision: "a".repeat(40),
        image: "attacker/image:latest",
        mode: "host-throwaway",
      }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported request fields"),
    });
    expect(mocks.buildAndReprovision).not.toHaveBeenCalled();
  });

  it("reports partial service results without pretending the batch succeeded", async () => {
    mocks.buildAndReprovision.mockResolvedValueOnce({
      ok: false,
      stage: "complete",
      executionId: "exec-canonical",
      artifactId: "artifact-1",
      captureId: "capture-1",
      generation: "generation-1",
      branch: "preview-development-1",
      sourceRevision: "a".repeat(40),
      catalogDigest: `sha256:${"b".repeat(64)}`,
      services: [
        {
          service: "function-router",
          build: { ok: false, error: "build failed" },
          provision: { ok: false, skipped: "build-failed" },
        },
      ],
    } as never);

    const response = (await POST(
      event({
        services: ["function-router"],
        origin: "https://wfb-preview1.tail286401.ts.net",
        adopt: true,
      }) as never,
    )) as Response;
    expect(response.status).toBe(207);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stage: "complete",
      services: [{ build: { ok: false, error: "build failed" } }],
    });
  });

  it("requires platform-admin ownership", async () => {
    mocks.isPlatformAdmin.mockResolvedValueOnce(false);
    const response = (await POST(
      event({
        services: ["workflow-builder"],
        origin: "https://wfb-preview1.tail286401.ts.net",
        adopt: true,
      }) as never,
    )) as Response;
    expect(response.status).toBe(403);
    expect(mocks.buildAndReprovision).not.toHaveBeenCalled();
  });
});
