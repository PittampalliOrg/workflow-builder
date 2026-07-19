import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn((request: Request) => {
    if (
      request.headers.get("x-preview-action-token") !== "preview-purpose-token"
    ) {
      throw new Error("invalid preview action token");
    }
  }),
  startWorkflow: vi.fn(async () => ({
    kind: "start-workflow",
    operationId: `pdt-start-workflow-${"b".repeat(64)}`,
    target: {},
    executionId: "child-1",
    workflowName: "preview-ui-development-gan",
    workflowSpecDigest: `sha256:${"c".repeat(64)}`,
    instanceId: "instance-1",
    status: "running",
    reused: false,
  })),
  getWorkflowStatus: vi.fn(),
  signalWorkflow: vi.fn(),
  verifyPromotion: vi.fn(async () => ({
    kind: "verify-promotion",
    verified: true,
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewTargetDevelopment: {
      startWorkflow: mocks.startWorkflow,
      getWorkflowStatus: mocks.getWorkflowStatus,
      signalWorkflow: mocks.signalWorkflow,
      verifyPromotion: mocks.verifyPromotion,
    },
  }),
}));

import { POST } from "./+server";

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "platform-1",
  sourceRevision: "source-1",
  catalogDigest: `sha256:${"a".repeat(64)}`,
};
const operationId = `pdt-start-workflow-${"b".repeat(64)}`;

function event(body: Record<string, unknown>) {
  return {
    request: new Request(
      "http://host/api/internal/preview-development/target",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-preview-action-token": "preview-purpose-token",
        },
        body: JSON.stringify(body),
      },
    ),
  };
}

describe("host preview development route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticates then delegates only the strict start command", async () => {
    const request = event({
      parentExecutionId: "parent-1",
      command: {
        kind: "start-workflow",
        operationId,
        target,
        input: {
          intent: "Update the dashboard",
          services: ["workflow-builder"],
          agentSlug: "kimi-k3-juicefs-builder-agent",
          keepPreview: true,
        },
      },
    });
    const response = (await POST(request as never)) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.requirePreviewActionInternal).toHaveBeenCalledWith(
      request.request,
    );
    expect(mocks.startWorkflow).toHaveBeenCalledWith({
      parentExecutionId: "parent-1",
      operationId,
      target,
      workflowInput: {
        intent: "Update the dashboard",
        services: ["workflow-builder"],
        agentSlug: "kimi-k3-juicefs-builder-agent",
        keepPreview: true,
      },
    });
  });

  it("rejects the broad internal token before target dispatch", async () => {
    const request = event({
      parentExecutionId: "parent-1",
      command: {
        kind: "start-workflow",
        operationId,
        target,
        input: {
          intent: "Update the dashboard",
          services: ["workflow-builder"],
        },
      },
    });
    request.request.headers.delete("x-preview-action-token");
    request.request.headers.set("x-internal-token", "broad-internal-token");
    await expect(POST(request as never)).rejects.toThrow(
      "invalid preview action token",
    );
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied actor before application dispatch", async () => {
    const response = (await POST(
      event({
        parentExecutionId: "parent-1",
        command: {
          kind: "start-workflow",
          operationId,
          target,
          input: {
            intent: "Update the dashboard",
            services: ["workflow-builder"],
          },
          actorUserId: "attacker",
        },
      }) as never,
    )) as Response;

    expect(response.status).toBe(400);
    expect(mocks.startWorkflow).not.toHaveBeenCalled();
  });

  it("delegates receipt verification without accepting caller authority", async () => {
    const verifyOperationId = `pdt-verify-promotion-${"d".repeat(64)}`;
    const receiptId = `pspr_${"e".repeat(64)}`;
    const response = (await POST(
      event({
        parentExecutionId: "parent-1",
        command: {
          kind: "verify-promotion",
          operationId: verifyOperationId,
          target,
          childExecutionId: "child-1",
          receiptId,
          services: ["workflow-builder"],
        },
      }) as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.verifyPromotion).toHaveBeenCalledWith({
      parentExecutionId: "parent-1",
      operationId: verifyOperationId,
      target,
      childExecutionId: "child-1",
      receiptId,
      services: ["workflow-builder"],
    });
  });
});
