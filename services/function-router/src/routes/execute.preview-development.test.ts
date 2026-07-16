import { describe, expect, it, vi } from "vitest";
import {
  buildPreviewDevelopmentProxyRequest,
  executePreviewDevelopmentAction,
  previewActionRequestAuthorized,
  previewDevelopmentCallerAuthorized,
  previewDevelopmentOperationId,
} from "./execute.js";

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};

describe("preview development action binding", () => {
  it("requires the purpose-specific caller token", () => {
    expect(previewDevelopmentCallerAuthorized(undefined, "secret-token")).toBe(
      false,
    );
    expect(
      previewDevelopmentCallerAuthorized("wrong-token", "secret-token"),
    ).toBe(false);
    expect(
      previewDevelopmentCallerAuthorized("secret-token", "secret-token"),
    ).toBe(true);
    expect(
      previewActionRequestAuthorized(
        "preview/workflow-signal",
        undefined,
        "token",
      ),
    ).toBe(false);
    expect(
      previewActionRequestAuthorized("dev/preview-promote", undefined, "token"),
    ).toBe(false);
    expect(
      previewActionRequestAuthorized("dev/preview-promote", "token", "token"),
    ).toBe(true);
    expect(
      previewActionRequestAuthorized("workspace/command", undefined, "token"),
    ).toBe(true);
  });

  it("builds a narrow host environment launch command", () => {
    const result = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/environment-launch",
      actionInput: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:call-1",
    });
    expect(result).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/environment",
        body: {
          parentExecutionId: "parent-1",
          command: {
            kind: "launch-environment",
            input: {
              environmentName: "feature-one",
              services: ["workflow-builder"],
              ttlHours: 8,
              retainAfterCompletion: false,
            },
          },
        },
      },
    });
    expect(result.ok && result.request.operationId).toMatch(
      /^pdt-launch-environment-[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(result)).not.toContain("userId");
    expect(JSON.stringify(result)).not.toContain("origin");
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("accepts trusted platform execution ids that start with url-safe punctuation", () => {
    const result = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/environment-launch",
      actionInput: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
      dbExecutionId: "-EOL5B879L-KygR0HVXB8",
      idempotencyKey: "workflow:-EOL5B879L-KygR0HVXB8:call-1",
    });

    expect(result).toMatchObject({
      ok: true,
      request: {
        body: {
          parentExecutionId: "-EOL5B879L-KygR0HVXB8",
        },
      },
    });
  });

  it("binds child start and typed signal commands to the exact tuple", () => {
    const start = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/workflow-start",
      actionInput: {
        target,
        intent: "Add a deployment health panel",
        services: ["workflow-builder", "function-router"],
      },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:start",
    });
    expect(start).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/target",
        body: {
          parentExecutionId: "parent-1",
          command: {
            kind: "start-workflow",
            target,
            input: {
              intent: "Add a deployment health panel",
              services: ["workflow-builder", "function-router"],
              keepPreview: "true",
            },
          },
        },
      },
    });

    const signal = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/workflow-signal",
      actionInput: {
        target,
        executionId: "child-1",
        workflowSpecDigest: `sha256:${"d".repeat(64)}`,
        action: "submit_preview_pr",
      },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:signal",
    });
    expect(signal).toMatchObject({
      ok: true,
      request: {
        body: {
          command: {
            kind: "signal-workflow",
            target,
            executionId: "child-1",
            workflowSpecDigest: `sha256:${"d".repeat(64)}`,
            action: "submit_preview_pr",
          },
        },
      },
    });

    const verification = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/workflow-verify-promotion",
      actionInput: {
        target,
        childExecutionId: "child-1",
        receiptId: `pspr_${"e".repeat(64)}`,
        services: ["workflow-builder", "function-router"],
      },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:verify",
    });
    expect(verification).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/target",
        body: {
          parentExecutionId: "parent-1",
          command: {
            kind: "verify-promotion",
            target,
            childExecutionId: "child-1",
            receiptId: `pspr_${"e".repeat(64)}`,
            services: ["workflow-builder", "function-router"],
          },
        },
      },
    });
    expect(verification.ok && verification.request.operationId).toMatch(
      /^pdt-verify-promotion-[0-9a-f]{64}$/,
    );
  });

  it("binds every lifecycle observation and teardown action to the exact tuple", () => {
    const workflowSpecDigest = `sha256:${"d".repeat(64)}`;
    const environmentStatus = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/environment-status",
      actionInput: { target },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:environment-status",
    });
    expect(environmentStatus).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/environment",
        body: {
          parentExecutionId: "parent-1",
          command: { kind: "get-environment-status", target },
        },
      },
    });
    expect(
      environmentStatus.ok && environmentStatus.request.operationId,
    ).toMatch(/^pdt-get-environment-status-[0-9a-f]{64}$/);

    const workflowStatus = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/workflow-status",
      actionInput: {
        target,
        executionId: "child-1",
        workflowSpecDigest,
      },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:workflow-status",
    });
    expect(workflowStatus).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/target",
        body: {
          parentExecutionId: "parent-1",
          command: {
            kind: "get-workflow-status",
            target,
            executionId: "child-1",
            workflowSpecDigest,
          },
        },
      },
    });
    expect(workflowStatus.ok && workflowStatus.request.operationId).toMatch(
      /^pdt-get-workflow-status-[0-9a-f]{64}$/,
    );

    const teardown = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/environment-teardown",
      actionInput: { target },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:teardown",
    });
    expect(teardown).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/environment",
        body: {
          parentExecutionId: "parent-1",
          command: { kind: "teardown-environment", target },
        },
      },
    });
    expect(teardown.ok && teardown.request.operationId).toMatch(
      /^pdt-teardown-environment-[0-9a-f]{64}$/,
    );

    const ticket = {
      name: target.previewName,
      environmentUid: "environment-uid-1",
      requestId: target.environmentRequestId,
      sourceRevision: target.sourceRevision,
      signature: "e".repeat(64),
    };
    const teardownStatus = buildPreviewDevelopmentProxyRequest({
      actionSlug: "preview/environment-teardown-status",
      actionInput: { target, ticket },
      dbExecutionId: "parent-1",
      idempotencyKey: "workflow:parent-1:teardown-status",
    });
    expect(teardownStatus).toMatchObject({
      ok: true,
      request: {
        path: "/api/internal/preview-development/environment",
        body: {
          parentExecutionId: "parent-1",
          command: {
            kind: "get-environment-teardown-status",
            target,
            ticket,
          },
        },
      },
    });
    expect(teardownStatus.ok && teardownStatus.request.operationId).toMatch(
      /^pdt-get-environment-teardown-status-[0-9a-f]{64}$/,
    );
  });

  it("rejects missing authority, arbitrary fields, forged targets, and untyped controls", () => {
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
        },
        dbExecutionId: null,
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["Workflow.Builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
        dbExecutionId: "parent-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
        dbExecutionId: "parent-1",
        idempotencyKey: "x".repeat(513),
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          userId: "attacker",
        },
        dbExecutionId: "parent-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/workflow-status",
        actionInput: {
          target: { ...target, sourceRevision: "main" },
          executionId: "child-1",
          workflowSpecDigest: `sha256:${"d".repeat(64)}`,
        },
        dbExecutionId: "parent-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/workflow-signal",
        actionInput: {
          target,
          executionId: "child-1",
          workflowSpecDigest: `sha256:${"d".repeat(64)}`,
          action: "run-shell",
        },
        dbExecutionId: "parent-1",
      }),
    ).toMatchObject({ ok: false });
    expect(
      buildPreviewDevelopmentProxyRequest({
        actionSlug: "preview/workflow-verify-promotion",
        actionInput: {
          target,
          childExecutionId: "child-1",
          receiptId: "forged-receipt",
          services: ["workflow-builder"],
        },
        dbExecutionId: "parent-1",
      }),
    ).toMatchObject({ ok: false });
  });

  it("derives stable operation ids from trusted activity idempotency", () => {
    const input = {
      parentExecutionId: "parent-1",
      commandKind: "start-workflow",
      idempotencyKey: "workflow:parent-1:call-1",
      actionSlug: "preview/workflow-start" as const,
    };
    expect(previewDevelopmentOperationId(input)).toBe(
      previewDevelopmentOperationId(input),
    );
    expect(previewDevelopmentOperationId(input)).not.toBe(
      previewDevelopmentOperationId({
        ...input,
        idempotencyKey: "workflow:parent-1:call-2",
      }),
    );
  });

  it("preserves permanent upstream failures in the action envelope", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: "tuple changed" }), {
          status: 409,
        }),
    );
    const result = await executePreviewDevelopmentAction(
      {
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
        dbExecutionId: "parent-1",
      },
      {
        previewActionToken: "preview-purpose-token",
        fetchImpl,
      },
    );
    expect(result).toMatchObject({
      success: false,
      error: "tuple changed",
      errorClass: "permanent",
      responseStatus: 409,
    });
    const headers = new Headers(fetchImpl.mock.calls[0]![1]?.headers);
    expect(headers.get("x-preview-action-token")).toBe("preview-purpose-token");
    expect(headers.has("x-internal-token")).toBe(false);
  });

  it("bounds a dropped BFF request and classifies it retryable", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("request aborted"));
          });
        }),
    );
    const result = await executePreviewDevelopmentAction(
      {
        actionSlug: "preview/environment-launch",
        actionInput: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
        dbExecutionId: "parent-1",
      },
      {
        previewActionToken: "preview-purpose-token",
        fetchImpl: fetchImpl as typeof fetch,
        timeoutMs: 5,
      },
    );
    expect(result).toMatchObject({
      success: false,
      errorClass: "retryable",
      responseStatus: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
