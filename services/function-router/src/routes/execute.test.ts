import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bindDevPreviewExecutionId,
  buildBrowserStartPreviewProxyRequest,
  buildDevPreviewBuildPayload,
  buildPreviewAcceptancePayload,
  buildWorkspaceCommandPayload,
  classifyDevPreviewProxyResponse,
  dispatchErrorPayload,
  executeBrowserStartPreviewAction,
  resolveWorkspaceUtilityTimeoutMs,
} from "./execute.js";

describe("dev preview execution binding", () => {
  it("derives preview authority from db_execution_id", () => {
    expect(bindDevPreviewExecutionId({}, "db-exec-1")).toEqual({
      ok: true,
      executionId: "db-exec-1",
    });
    expect(
      bindDevPreviewExecutionId({ executionId: "db-exec-1" }, "db-exec-1"),
    ).toEqual({ ok: true, executionId: "db-exec-1" });
  });

  it("rejects arbitrary or missing execution identity", () => {
    expect(
      bindDevPreviewExecutionId(
        { executionId: "other-admin-run" },
        "db-exec-1",
      ),
    ).toEqual({
      ok: false,
      error:
        "dev/preview: input.executionId does not match trusted db_execution_id.",
    });
    expect(bindDevPreviewExecutionId({ executionId: "exec-1" }, null)).toEqual({
      ok: false,
      error:
        "dev/preview: missing trusted `db_execution_id` context; caller-supplied execution IDs are not accepted.",
    });
  });

  it("uses only the dedicated preview-action credential for privileged proxies", () => {
    const source = readFileSync(
      new URL("./execute.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async function executeDevPreview(");
    const end = source.indexOf("\nfunction ", start + 1);
    const previewProxy = source.slice(start, end > start ? end : undefined);
    expect(previewProxy).toContain("PREVIEW_ACTION_INTERNAL_TOKEN");
    expect(previewProxy).toContain('"X-Preview-Action-Token"');
    expect(previewProxy).not.toContain('"X-Internal-Token"');
    expect(source).toContain("body.db_execution_id,");
  });

  it("forwards only safe development-build choices", () => {
    expect(
      buildDevPreviewBuildPayload({
        services: ["workflow-builder", "function-router"],
        origin: "https://wfb-preview1.tail286401.ts.net",
        adopt: false,
        executionId: "another-execution",
        repo: "attacker/repo",
        base: "evil",
        sourceRevision: "a".repeat(40),
        image: "attacker/image:latest",
        dockerfile: "../../Dockerfile",
        mode: "host-throwaway",
      }),
    ).toEqual({
      services: ["workflow-builder", "function-router"],
      origin: "https://wfb-preview1.tail286401.ts.net",
      adopt: false,
    });
  });

  it("forwards only the PR tuple for immutable acceptance", () => {
    expect(
      buildPreviewAcceptancePayload({
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          services: ["attacker-service"],
        },
        platformRevision: "c".repeat(40),
        services: ["attacker-service"],
        retainOnSuccess: true,
      }),
    ).toEqual({
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
      },
    });
  });
});

describe("durable dev preview activation envelope", () => {
  const executionId = "db-exec-1";
  const requestInput = {
    mode: "preview-native",
    services: ["workflow-builder", "function-router"],
  };
  const serviceResult = (service: string) => ({
    service,
    ok: true,
    info: {
      executionId,
      service,
      ready: true,
      sandboxName: `dev-${service}`,
      podIP: service === "workflow-builder" ? "10.0.0.10" : "10.0.0.11",
      syncUrl: `http://dev-${service}:8001/__sync`,
    },
  });
  const lifecycle = {
    executionId,
    services: requestInput.services.map(serviceResult),
    ok: true,
    batchId: "batch-1",
  };

  it("preserves exact pending and active target statuses", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 202,
        parsed: {
          ...lifecycle,
          complete: false,
          pending: true,
          activationPhase: "scheduled",
        },
      }),
    ).toMatchObject({
      success: true,
      responseStatus: 202,
      data: { batchId: "batch-1", activationPhase: "scheduled" },
    });

    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 200,
        parsed: {
          ...lifecycle,
          complete: true,
          pending: false,
          activationPhase: "active",
        },
      }),
    ).toMatchObject({
      success: true,
      responseStatus: 200,
      data: { batchId: "batch-1", activationPhase: "active" },
    });
  });

  it.each([
    ["empty", []],
    ["partial", [serviceResult("workflow-builder")]],
    [
      "duplicate",
      [serviceResult("workflow-builder"), serviceResult("workflow-builder")],
    ],
    [
      "unexpected",
      [
        serviceResult("workflow-builder"),
        serviceResult("workflow-orchestrator"),
      ],
    ],
    [
      "unready",
      [
        serviceResult("workflow-builder"),
        {
          ...serviceResult("function-router"),
          info: { ...serviceResult("function-router").info, ready: false },
        },
      ],
    ],
  ])("rejects an %s activation service receipt", (_label, services) => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 200,
        parsed: {
          ...lifecycle,
          services,
          complete: true,
          pending: false,
          activationPhase: "active",
        },
      }),
    ).toMatchObject({
      success: false,
      errorClass: "permanent",
      responseStatus: 200,
    });
  });

  it("rejects duplicate requested services", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput: {
          ...requestInput,
          services: ["workflow-builder", "workflow-builder"],
        },
        executionId,
        status: 200,
        parsed: {
          ...lifecycle,
          complete: true,
          pending: false,
          activationPhase: "active",
        },
      }),
    ).toMatchObject({ success: false, errorClass: "permanent" });
  });

  it("rejects a lifecycle phase carried by the wrong HTTP status", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 200,
        parsed: {
          ...lifecycle,
          complete: false,
          pending: true,
          activationPhase: "activating",
        },
      }),
    ).toMatchObject({
      success: false,
      errorClass: "permanent",
      responseStatus: 200,
    });
  });

  it("retries replacement failures but not an explicit failed batch", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 503,
        parsed: { error: "upstream unavailable" },
      }),
    ).toMatchObject({ success: false, errorClass: "retryable" });

    expect(
      classifyDevPreviewProxyResponse({
        mode: "ensure",
        requestInput,
        executionId,
        status: 503,
        parsed: {
          error: "activation failed",
          ok: false,
          activationPhase: "failed",
          batchId: "batch-1",
        },
      }),
    ).toMatchObject({ success: false, errorClass: "permanent" });
  });
});

describe("dev preview freeze proxy envelope", () => {
  it("passes a committed freeze receipt through as success", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "freeze",
        requestInput: { services: ["workflow-builder"] },
        executionId: "db-exec-1",
        status: 200,
        parsed: {
          ok: true,
          executionId: "db-exec-1",
          services: [
            {
              service: "workflow-builder",
              status: "frozen",
              message: "source receiver is frozen",
            },
          ],
        },
      }),
    ).toMatchObject({ success: true, responseStatus: 200 });
  });

  it("keeps a partial freeze failure retryable (freeze is idempotent per service)", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "freeze",
        requestInput: { services: ["workflow-builder"] },
        executionId: "db-exec-1",
        status: 502,
        parsed: {
          ok: false,
          executionId: "db-exec-1",
          services: [
            {
              service: "workflow-builder",
              status: "failed",
              message: "dev-preview receiver is unavailable for workflow-builder",
            },
          ],
        },
      }),
    ).toMatchObject({
      success: false,
      errorClass: "retryable",
      responseStatus: 502,
    });
  });
});

describe("workspace command routing", () => {
  it("forwards cwd to the workspace runtime", () => {
    const payload = buildWorkspaceCommandPayload({
      args: {
        workspaceRef: "swebench-sympy-20590",
        command: "git status --short",
        cwd: "/testbed",
        timeoutMs: 120000,
      },
      executionId: "exec-1",
      dbExecutionId: "db-exec-1",
      workflowId: "workflow-1",
      nodeId: "checkout_repo",
      nodeName: "checkout_repo",
    });

    expect(payload).toMatchObject({
      workspaceRef: "swebench-sympy-20590",
      command: "git status --short",
      cwd: "/testbed",
      timeoutMs: 120000,
    });
  });

  it("accepts workingDir aliases for browser/workspace callers", () => {
    const payload = buildWorkspaceCommandPayload({
      args: {
        workspaceRef: "workspace-1",
        prompt: "pwd",
        workingDirectory: "/sandbox/app",
      },
      executionId: "exec-1",
      workflowId: "workflow-1",
      nodeId: "command",
      nodeName: "command",
    });

    expect(payload).toMatchObject({
      workspaceRef: "workspace-1",
      command: "pwd",
      cwd: "/sandbox/app",
    });
  });
});

describe("browser preview application routing", () => {
  it("binds preview authority to db_execution_id and forwards only start options", () => {
    expect(
      buildBrowserStartPreviewProxyRequest({
        actionInput: {
          workspaceRef: "caller-workspace",
          sandboxName: "caller-sandbox",
          rootPath: "/caller/root",
          previewId: "preview-1",
          repoPath: "/sandbox/app",
          baseUrl: "http://127.0.0.1:3009",
          timeoutSeconds: 120,
        },
        dbExecutionId: "exec-1",
        nodeId: "preview",
      }),
    ).toEqual({
      ok: true,
      request: {
        executionId: "exec-1",
        path: "/api/internal/workflows/executions/exec-1/sandbox-preview",
        body: {
          previewId: "preview-1",
          repoPath: "/sandbox/app",
          installCommand: undefined,
          devServerCommand: undefined,
          baseUrl: "http://127.0.0.1:3009",
          timeoutSeconds: 120,
        },
      },
    });
    expect(
      buildBrowserStartPreviewProxyRequest({
        actionInput: { executionId: "forged-exec" },
        dbExecutionId: null,
        nodeId: "preview",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("trusted") });
  });

  it("returns canonical proxy URLs and strips runtime-local addresses", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        success: true,
        executionId: "exec-1",
        previewId: "preview-1",
        workspaceRef: "workspace-1",
        proxyUrl:
          "https://workflow.example/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
        pageUrl:
          "https://workflow.example/workspaces/wf/workflows/runtime-preview/exec-1?previewId=preview-1",
        baseUrl: "http://127.0.0.1:43127",
        proxyPath: "/api/workspaces/preview/preview-1/",
        status: "running",
      }),
    );

    const response = await executeBrowserStartPreviewAction(
      {
        actionInput: {
          previewId: "preview-1",
          repoPath: "/sandbox/app",
          baseUrl: "http://127.0.0.1:3009",
        },
        dbExecutionId: "exec-1",
        nodeId: "preview",
      },
      {
        fetchImpl: fetchImpl as typeof fetch,
        previewActionToken: "purpose-token",
        workflowBuilderUrl: "http://workflow-builder:3000",
      },
    );

    expect(response.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://workflow-builder:3000/api/internal/workflows/executions/exec-1/sandbox-preview",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Preview-Action-Token": "purpose-token",
        }),
      }),
    );
    expect(response.data).toMatchObject({
      previewId: "preview-1",
      proxyUrl:
        "https://workflow.example/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
      requestedBaseUrl: "http://127.0.0.1:3009",
    });
    expect(response.data).not.toHaveProperty("baseUrl");
    expect(response.data).not.toHaveProperty("proxyPath");
    expect(response.data).not.toHaveProperty("result.baseUrl");
    expect(response.data).not.toHaveProperty("result.proxyPath");
  });
});

describe("workspace utility timeout routing", () => {
  it("honors long workspace/profile timeout budgets for Kueue-backed sandboxes", () => {
    expect(
      resolveWorkspaceUtilityTimeoutMs({
        toolId: "profile",
        timeoutMs: 2_100_000,
        commandTimeoutMs: undefined,
      }),
    ).toBe(2_100_000);
  });

  it("still caps workspace/profile timeout budgets at the utility ceiling", () => {
    expect(
      resolveWorkspaceUtilityTimeoutMs({
        toolId: "profile",
        timeoutMs: 9_000_000,
        commandTimeoutMs: undefined,
      }),
    ).toBe(3_600_000);
  });
});

describe("dispatch content tracing", () => {
  it("summarizes thrown downstream dispatch errors as output payloads", () => {
    expect(
      dispatchErrorPayload(
        new Error("fetch failed"),
        "/api/workspaces/profile",
      ),
    ).toEqual({
      success: false,
      error: "fetch failed",
      errorType: "Error",
      targetPath: "/api/workspaces/profile",
    });
  });
});
