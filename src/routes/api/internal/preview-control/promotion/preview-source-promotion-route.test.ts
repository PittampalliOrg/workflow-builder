import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewControlCapability: vi.fn(),
  promote: vi.fn(async (input) => ({
    ok: true,
    previewName: input.previewName,
    requestId: input.environmentRequestId,
    executionId: input.executionId,
    artifactId: input.artifactId,
    services: ["workflow-builder"],
    branch: "preview-feature-42",
    commitSha: "c".repeat(40),
    prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
    draft: input.draft,
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewSourcePromotionBroker: { promote: mocks.promote },
  }),
}));

import { POST } from "./+server";
import { PREVIEW_CONTROL_JSON_MAX_BYTES } from "../../_shared/bounded-json-body";

const identity = {
  previewName: "preview-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}`,
};
const artifactIdentity = {
  previewName: "preview-one",
  requestId: "request-1",
  executionId: "execution-1",
  sourceArtifactId: "source-artifact-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}`,
  services: ["workflow-builder"],
  captureId: "capture-1",
  generation: "generation-1",
  fileDigest: `sha256:${"e".repeat(64)}`,
};

function event(extra: Record<string, unknown> = {}) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/promotion",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "operation-1",
          ...identity,
          executionId: "execution-1",
          artifactId: "central-artifact-1",
          artifactIdentity,
          title: "Feature change",
          bodyMarkdown: null,
          draft: true,
          ...extra,
        }),
      },
    ),
  };
}

describe("preview source promotion physical route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PREVIEW_CONTROL_BROKER_MODE", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("authenticates the exact tuple and forwards the narrow command", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlCapability).toHaveBeenCalledWith(
      expect.any(Request),
      identity,
    );
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        artifactIdentity,
        artifactId: "central-artifact-1",
      }),
    );
  });

  it("forwards the server-derived host execution id for parent run artifacts", async () => {
    const response = (await POST(
      event({ hostExecutionId: "parent-exec-1" }) as never,
    )) as Response;
    expect(response.status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "execution-1",
        hostExecutionId: "parent-exec-1",
      }),
    );
  });

  it("rejects caller repository authority before broker execution", async () => {
    const response = (await POST(
      event({ repository: "attacker/repo", base: "attacker" }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("is absent outside the physical broker deployment", async () => {
    vi.stubEnv("PREVIEW_CONTROL_BROKER_MODE", "false");
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(404);
    expect(mocks.promote).not.toHaveBeenCalled();
  });

  it("rejects a chunked oversized command before capability or broker work", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `{"padding":"${"x".repeat(PREVIEW_CONTROL_JSON_MAX_BYTES)}`,
          ),
        );
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const request = new Request(
      "http://broker/api/internal/preview-control/promotion",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" },
    );

    const response = (await POST({ request } as never)) as Response;
    expect(response.status).toBe(413);
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
  });
});
