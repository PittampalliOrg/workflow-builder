import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewControlCapability: vi.fn(),
  build: vi.fn(async () => ({
    ok: true,
    previewName: "preview1",
    branch: "preview-development-1720550000",
    sourceRevision: "a".repeat(40),
    baselineRevision: "b".repeat(40),
    pullRequestBase: "main",
    changedPaths: ["src/changed.ts"],
    catalogDigest: `sha256:${"d".repeat(64)}`,
    services: [],
  })),
}));

vi.mock("$env/dynamic/private", () => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDevelopmentBuildBroker: { build: mocks.build },
  }),
}));

import { POST } from "./+server";
import { PREVIEW_CONTROL_JSON_MAX_BYTES } from "../../_shared/bounded-json-body";

const body = {
  requestId: "request-1",
  executionId: "exec-1",
  artifactId: "central-artifact-1",
  previewName: "preview1",
  catalogDigest: `sha256:${"d".repeat(64)}`,
  services: ["workflow-builder"],
  environmentRequestId: "launch-1",
  environmentPlatformRevision: "e".repeat(40),
  environmentSourceRevision: "f".repeat(40),
  artifactIdentity: {
    previewName: "preview1",
    requestId: "launch-1",
    executionId: "exec-1",
    sourceArtifactId: "artifact-1",
    platformRevision: "e".repeat(40),
    sourceRevision: "f".repeat(40),
    catalogDigest: `sha256:${"d".repeat(64)}`,
    services: ["workflow-builder"],
    captureId: "capture-1",
    generation: "generation-1",
    fileDigest: `sha256:${"9".repeat(64)}`,
  },
};

function event(payload: Record<string, unknown> = body) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/development-build",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  };
}

describe("physical preview-control development build route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the broker credential and delegates the narrow command", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlCapability).toHaveBeenCalledOnce();
    expect(mocks.build).toHaveBeenCalledWith(body);
  });

  it("rejects repository, image, and kubeconfig authority in the request", async () => {
    const response = (await POST(
      event({
        ...body,
        repository: "attacker/repo",
        image: "attacker/image",
        kubeconfig: "secret",
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("unsupported broker fields"),
    });
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized command before capability or build work", async () => {
    const request = new Request(
      "http://broker/api/internal/preview-control/development-build",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(PREVIEW_CONTROL_JSON_MAX_BYTES + 1),
        },
        body: "{}",
      },
    );
    const response = (await POST({ request } as never)) as Response;
    expect(response.status).toBe(413);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
