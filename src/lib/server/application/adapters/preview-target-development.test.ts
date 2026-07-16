import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpPreviewTargetDevelopmentBrokerAdapter,
  HttpPreviewTargetDevelopmentLeafAdapter,
} from "$lib/server/application/adapters/preview-target-development";

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "platform-1",
  sourceRevision: "source-1",
  catalogDigest: `sha256:${"a".repeat(64)}` as const,
};
const workflow = {
  executionId: "child-1",
  workflowName: "microservice-dev-session" as const,
  workflowSpecDigest: `sha256:${"c".repeat(64)}` as const,
};
const operationId = `pdt-start-workflow-${"b".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function success() {
  return new Response(
    JSON.stringify({
      kind: "start-workflow",
      operationId,
      target,
      ...workflow,
      instanceId: "instance-1",
      status: "running",
      reused: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("preview development HTTP adapters", () => {
  it("sends a strict host-to-broker command with purpose-specific auth", async () => {
    const fetchImpl = vi.fn(async () => success());
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });

    await adapter.startWorkflow({
      parentExecutionId: "parent-1",
      actorUserId: "admin-1",
      operationId,
      target,
      workflow,
      workflowInput: {
        intent: "Update the dashboard",
        services: ["workflow-builder"],
        keepPreview: true,
      },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://physical-broker.example/api/internal/preview-control/development",
    );
    expect(
      new Headers(init.headers).get("x-preview-control-broker-token"),
    ).toBe("broker-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      parentExecutionId: "parent-1",
      command: {
        kind: "start-workflow",
        actorUserId: "admin-1",
        operationId,
        target,
        executionId: "child-1",
        workflowSpecDigest: workflow.workflowSpecDigest,
        input: {
          intent: "Update the dashboard",
          services: ["workflow-builder"],
          keepPreview: true,
        },
      },
    });
  });

  it("keeps the preview URL and capability out of the leaf request body", async () => {
    const fetchImpl = vi.fn(async () => success());
    const adapter = new HttpPreviewTargetDevelopmentLeafAdapter({ fetchImpl });

    await adapter.startWorkflow({
      parentExecutionId: "parent-1",
      actorUserId: "admin-1",
      operationId,
      target,
      workflow,
      workflowInput: {
        intent: "Update the dashboard",
        services: ["workflow-builder"],
      },
      targetUrl: "https://wfb-feature-one.tail286401.ts.net",
      capability: "leaf-secret",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "http://workflow-builder-x-workflow-builder-x-feature-one.vcluster-feature-one.svc.cluster.local:3000/api/internal/preview-control/development",
    );
    expect(new Headers(init.headers).get("x-preview-control-capability")).toBe(
      "leaf-secret",
    );
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("targetUrl");
    expect(body).not.toHaveProperty("capability");
    expect(body.command).not.toHaveProperty("workflowName");
  });

  it("never propagates a candidate-controlled leaf error body or code", async () => {
    const syncToken = "SYNC_TOKEN=preview-secret-that-must-not-escape";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: `exfiltrated ${syncToken}`,
            code: "unauthorized",
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new HttpPreviewTargetDevelopmentLeafAdapter({ fetchImpl });

    let failure: unknown;
    try {
      await adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
        targetUrl: "https://wfb-feature-one.tail286401.ts.net",
        capability: "leaf-secret",
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toMatchObject({
      code: "contract-mismatch",
      message: "preview development endpoint returned HTTP 409",
    });
    expect(String(failure)).not.toContain(syncToken);
    expect(String(failure)).not.toContain("exfiltrated");
    expect(String(failure)).not.toContain("unauthorized");
  });

  it("preserves bounded structured errors from the trusted physical broker", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "physical preview is still provisioning",
            code: "not-ready",
          }),
          { status: 425, headers: { "content-type": "application/json" } },
        ),
    );
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });

    await expect(
      adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({
      code: "not-ready",
      message: "physical preview is still provisioning",
    });
  });

  it("sends physical promotion verification only to the broker token endpoint", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ kind: "verify-promotion" }), {
          status: 200,
        }),
    );
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });
    const verifyOperationId = `pdt-verify-promotion-${"d".repeat(64)}`;

    await adapter.verifyPromotion({
      parentExecutionId: "parent-1",
      actorUserId: "admin-1",
      operationId: verifyOperationId,
      target,
      childExecutionId: "child-1",
      receiptId: `pspr_${"e".repeat(64)}`,
      services: ["workflow-builder"],
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://physical-broker.example/api/internal/preview-control/development",
    );
    expect(
      new Headers(init.headers).get("x-preview-control-broker-token"),
    ).toBe("broker-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      parentExecutionId: "parent-1",
      command: {
        kind: "verify-promotion",
        actorUserId: "admin-1",
        operationId: verifyOperationId,
        target,
        childExecutionId: "child-1",
        receiptId: `pspr_${"e".repeat(64)}`,
        services: ["workflow-builder"],
      },
    });
  });

  it("rejects an oversized declared response before reading its body", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(new TextEncoder().encode('{"ignored":true}'));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-length": String(256 * 1024 + 1) },
        }),
    );
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });

    await expect(
      adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({
      code: "upstream-failure",
      message: "preview development response is oversized",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(0);
  });

  it("cancels a chunked response as soon as its incremental byte limit is exceeded", async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new Uint8Array(200 * 1024));
            return;
          }
          if (pulls === 2) {
            controller.enqueue(new Uint8Array(56 * 1024 + 1));
            return;
          }
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });

    await expect(
      adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({
      code: "upstream-failure",
      message: "preview development response is oversized",
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  });

  it("rejects bounded JSON values that are not objects", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(["not", "an", "object"]), { status: 200 }),
    );
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
    });

    await expect(
      adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({
      code: "upstream-failure",
      message: "preview development endpoint returned invalid JSON",
    });
  });

  it("keeps one fixed deadline while consuming the response stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Keep the read pending until the fixed request deadline aborts it.
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const adapter = new HttpPreviewTargetDevelopmentBrokerAdapter({
      baseUrl: () => "https://physical-broker.example",
      token: () => "broker-secret",
      fetchImpl,
      timeoutMs: 20,
    });

    await expect(
      adapter.startWorkflow({
        parentExecutionId: "parent-1",
        actorUserId: "admin-1",
        operationId,
        target,
        workflow,
        workflowInput: { intent: "Update", services: ["workflow-builder"] },
      }),
    ).rejects.toMatchObject({ code: "upstream-failure" });
    expect(cancelled).toBe(true);
  });
});
