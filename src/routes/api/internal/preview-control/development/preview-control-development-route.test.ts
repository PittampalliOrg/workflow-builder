import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: { PREVIEW_CONTROL_BROKER_MODE: "true" },
  requirePreviewControlBroker: vi.fn(),
  requirePreviewControlCapability: vi.fn(),
  verifyPromotion: vi.fn(async () => ({
    kind: "verify-promotion",
    verified: true,
  })),
}));

vi.mock("$env/dynamic/private", () => ({ env: mocks.env }));
vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requirePreviewControlBroker,
  requirePreviewControlCapability: mocks.requirePreviewControlCapability,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewTargetDevelopmentBroker: {
      startWorkflow: vi.fn(),
      getWorkflowStatus: vi.fn(),
      signalWorkflow: vi.fn(),
      verifyPromotion: mocks.verifyPromotion,
    },
    previewTargetDevelopmentLocal: {
      startWorkflow: vi.fn(),
      getWorkflowStatus: vi.fn(),
      signalWorkflow: vi.fn(),
    },
  }),
}));

import { POST } from "./+server";

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};

function event() {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/development",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parentExecutionId: "parent-1",
          command: {
            kind: "verify-promotion",
            actorUserId: "admin-1",
            operationId: `pdt-verify-promotion-${"d".repeat(64)}`,
            target,
            childExecutionId: "child-1",
            receiptId: `pspr_${"e".repeat(64)}`,
            services: ["workflow-builder"],
          },
        }),
      },
    ),
  };
}

describe("preview development physical broker route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "true";
  });

  it("authenticates and delegates durable receipt verification only in broker mode", async () => {
    const request = event();
    const response = (await POST(request as never)) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlBroker).toHaveBeenCalledWith(
      request.request,
    );
    expect(mocks.verifyPromotion).toHaveBeenCalledWith({
      kind: "verify-promotion",
      parentExecutionId: "parent-1",
      actorUserId: "admin-1",
      operationId: `pdt-verify-promotion-${"d".repeat(64)}`,
      target,
      childExecutionId: "child-1",
      receiptId: `pspr_${"e".repeat(64)}`,
      services: ["workflow-builder"],
    });
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
  });

  it("rejects physical receipt verification on a preview-local deployment", async () => {
    mocks.env.PREVIEW_CONTROL_BROKER_MODE = "false";

    const response = (await POST(event() as never)) as Response;

    expect(response.status).toBe(400);
    expect(mocks.verifyPromotion).not.toHaveBeenCalled();
    expect(mocks.requirePreviewControlCapability).not.toHaveBeenCalled();
  });
});
