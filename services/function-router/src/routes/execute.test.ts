import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  bindDevPreviewExecutionId,
  buildBrowserStartPreviewProxyRequest,
  buildBrowserEvidencePayload,
  buildDevPreviewBuildPayload,
  buildPreviewAcceptancePayload,
  buildPreviewWorkspaceActionPayload,
  buildWorkspaceCommandPayload,
  buildWorkspaceMaterializeFilesPayload,
  classifyDevPreviewProxyResponse,
  credentiallessDevPreviewReceipt,
  dispatchErrorPayload,
  executeBrowserStartPreviewAction,
  resolveWorkspaceUtilityTimeoutMs,
  workspaceMaterializeInputForSpan,
  workspaceMaterializedFilesFromResponse,
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

describe("credentialless preview workspace routing", () => {
  it("accepts only server-selectable action fields", () => {
    expect(
      buildPreviewWorkspaceActionPayload(
        { service: "workflow-builder" },
        "workspace-sync",
      ),
    ).toEqual({
      ok: true,
      payload: { service: "workflow-builder" },
    });
    expect(
      buildPreviewWorkspaceActionPayload(
        {
          service: "workflow-builder",
          executionId: "caller-execution",
          syncUrl: "http://caller",
        },
        "workspace-sync",
      ),
    ).toMatchObject({ ok: false });
  });

  it("strips nested receiver coordinates without mutating nested shapes", () => {
    const projected = credentiallessDevPreviewReceipt({
      ok: true,
      syncUrl: "http://receiver/fingerprint",
      services: [
        {
          service: "workflow-builder",
          syncCapability: "capability-fingerprint",
          nested: {
            syncToken: "token-fingerprint",
            agentActionToken: "agent-fingerprint",
            value: "kept",
          },
        },
      ],
    });
    expect(projected).toMatchObject({
      ok: true,
      receiptMode: "credentialless",
      services: [
        {
          service: "workflow-builder",
          nested: { value: "kept" },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /fingerprint|syncUrl|syncCapability|syncToken|agentActionToken/,
    );
    expect(
      (projected as { services: Array<Record<string, unknown>> }).services[0],
    ).not.toHaveProperty("receiptMode");
  });

  it("never retries an ambiguous sidecar command response", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "sidecar-run",
        requestInput: { service: "workflow-builder", command: "check" },
        executionId: "db-exec-1",
        status: 502,
        parsed: { error: "receiver response was lost" },
      }),
    ).toMatchObject({ success: false, errorClass: "permanent" });
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
      data: {
        batchId: "batch-1",
        activationPhase: "active",
        receiptMode: "credentialless",
        services: requestInput.services.map((service) => ({
          service,
          ok: true,
          info: {
            executionId,
            service,
            ready: true,
            sandboxName: `dev-${service}`,
            podIP:
              service === "workflow-builder" ? "10.0.0.10" : "10.0.0.11",
          },
        })),
      },
    });
    const active = classifyDevPreviewProxyResponse({
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
    });
    expect(JSON.stringify(active.data)).not.toContain("syncUrl");
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
    [
      "missing receiver coordinate",
      [
        serviceResult("workflow-builder"),
        {
          ...serviceResult("function-router"),
          info: {
            executionId,
            service: "function-router",
            ready: true,
            sandboxName: "dev-function-router",
            podIP: "10.0.0.11",
          },
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

describe("dev preview browser evidence proxy", () => {
  it("forwards only claims and excludes caller-controlled authority", () => {
    const evidence = [
      {
        storageRef: "workflow-browser-artifacts/exec-1/bwf_1/screenshot.png",
        width: 1440,
        height: 1000,
      },
    ];
    expect(
      buildBrowserEvidencePayload({
        evidence,
        executionId: "caller-controlled",
        principalAssertion: "secret",
      }),
    ).toEqual({ evidence });
  });

  it("classifies invalid evidence as permanent", () => {
    expect(
      classifyDevPreviewProxyResponse({
        mode: "browser-evidence",
        requestInput: { evidence: [] },
        executionId: "db-exec-1",
        status: 422,
        parsed: {
          error: "Screenshot evidence dimensions do not match the claim",
        },
      }),
    ).toMatchObject({
      success: false,
      errorClass: "permanent",
      responseStatus: 422,
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

describe("workspace materialize-files routing", () => {
  const context = {
    executionId: "dapr-instance-1",
    dbExecutionId: "db-exec-1",
    workflowId: "workflow-1",
    nodeId: "materialize",
    nodeName: "materialize",
  };

  it("encodes a bounded text batch for the OpenShell materializer", () => {
    const payload = buildWorkspaceMaterializeFilesPayload({
      ...context,
      toolId: "materialize-files",
      args: {
        workspaceRef: "workspace-1",
        timeoutMs: 120000,
        files: [
          { path: "/sandbox/app/index.html", content: "<p>piñata</p>" },
          { path: "/sandbox/app/run.sh", content: "echo ok\n", mode: 0o755 },
        ],
      },
    });

    expect(payload).toMatchObject({
      executionId: "dapr-instance-1",
      dbExecutionId: "db-exec-1",
      workspaceRef: "workspace-1",
      timeoutMs: 120000,
      workflowId: "workflow-1",
      nodeId: "materialize",
      nodeName: "materialize",
      files: [
        {
          path: "/sandbox/app/index.html",
          contentB64: Buffer.from("<p>piñata</p>", "utf8").toString("base64"),
        },
        {
          path: "/sandbox/app/run.sh",
          contentB64: Buffer.from("echo ok\n", "utf8").toString("base64"),
          mode: 0o755,
        },
      ],
    });
    expect(JSON.stringify(payload)).not.toContain("piñata");
    expect(JSON.stringify(payload)).not.toContain('"content"');
  });

  it("traces file metadata and digests without source or encoded bodies", () => {
    const traceInput = workspaceMaterializeInputForSpan(
      "workspace/materialize-files",
      {
        toolId: "materialize-files",
        workspaceRef: "workspace-1",
        files: [
          { path: "/sandbox/app/index.html", content: "private source" },
          {
            path: "/sandbox/app/logo.png",
            contentB64: Buffer.from("private image").toString("base64"),
          },
        ],
      },
    );

    expect(traceInput).toMatchObject({
      toolId: "materialize-files",
      workspaceRef: "workspace-1",
      fileCount: 2,
      files: [
        {
          path: "/sandbox/app/index.html",
          contentBytes: 14,
          contentEncoding: "utf8",
        },
        {
          path: "/sandbox/app/logo.png",
          contentEncoding: "base64",
        },
      ],
    });
    const serialized = JSON.stringify(traceInput);
    expect(serialized).not.toContain("private source");
    expect(serialized).not.toContain(
      Buffer.from("private image").toString("base64"),
    );
    expect(
      workspaceMaterializeInputForSpan("mastra/run-tool", {
        toolId: "write_file",
        content: "not a workspace materializer",
      }),
    ).toEqual({
      toolId: "write_file",
      content: "not a workspace materializer",
    });
  });

  it("keeps workspace/write_file as a one-file compatibility alias", () => {
    const payload = buildWorkspaceMaterializeFilesPayload({
      ...context,
      toolId: "write_file",
      args: {
        workspaceRef: "workspace-1",
        path: "/sandbox/app/index.html",
        content: "hello",
      },
    });

    expect(payload.files).toEqual([
      {
        path: "/sandbox/app/index.html",
        contentB64: Buffer.from("hello", "utf8").toString("base64"),
      },
    ]);
  });

  it.each([
    "/../../workspace/runtime.py",
    "/tmp/runtime.py",
    "/sandbox/app/../runtime.py",
    "/sandbox//app/index.html",
    "/sandbox/app/./index.html",
    " /sandbox/app/index.html",
  ])("rejects non-normalized materialization path %s", (path) => {
    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [{ path, content: "blocked" }],
        },
      }),
    ).toThrow("normalized absolute path");
  });

  it("rejects malformed base64 and oversized file content", () => {
    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [
            { path: "/sandbox/app/index.html", contentB64: "not base64!" },
          ],
        },
      }),
    ).toThrow("canonical base64");

    const boundaryContent = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    expect(
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [
            {
              path: "/sandbox/app/boundary.bin",
              contentB64: boundaryContent,
            },
          ],
        },
      }).files,
    ).toEqual([
      {
        path: "/sandbox/app/boundary.bin",
        contentB64: boundaryContent,
      },
    ]);

    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [
            {
              path: "/sandbox/app/large.bin",
              contentB64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
            },
          ],
        },
      }),
    ).toThrow("4 MiB limit");
  });

  it("rejects batches over the aggregate decoded-byte limit", () => {
    const boundaryContent = Buffer.alloc(4 * 1024 * 1024).toString("base64");
    expect(
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [
            { path: "/sandbox/app/first.bin", contentB64: boundaryContent },
            { path: "/sandbox/app/second.bin", contentB64: boundaryContent },
          ],
        },
      }).files,
    ).toHaveLength(2);

    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: Array.from({ length: 3 }, (_, index) => ({
            path: `/sandbox/app/file-${index}.bin`,
            contentB64: boundaryContent,
          })),
        },
      }),
    ).toThrow("8 MiB aggregate limit");
  });

  it("requires workspace authority and non-overlapping destinations", () => {
    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          files: [{ path: "/sandbox/app/index.html", content: "missing ref" }],
        },
      }),
    ).toThrow("requires workspaceRef");

    expect(() =>
      buildWorkspaceMaterializeFilesPayload({
        ...context,
        toolId: "materialize-files",
        args: {
          workspaceRef: "workspace-1",
          files: [
            { path: "/sandbox/app", content: "file" },
            { path: "/sandbox/app/index.html", content: "overlap" },
          ],
        },
      }),
    ).toThrow("overlaps another destination");
  });

  it("exposes a flat files list while preserving the standard result envelope", () => {
    expect(
      workspaceMaterializedFilesFromResponse({
        success: true,
        files: ["/sandbox/app/index.html"],
      }),
    ).toEqual(["/sandbox/app/index.html"]);
    expect(
      workspaceMaterializedFilesFromResponse({
        success: true,
        result: { files: ["/sandbox/app/legacy.html"] },
      }),
    ).toEqual(["/sandbox/app/legacy.html"]);
  });

  it("dispatches both slugs to the supported OpenShell endpoint", () => {
    const source = readFileSync(new URL("./execute.ts", import.meta.url), "utf8");
    expect(source).toContain(
      '(toolId === "materialize-files" || toolId === "write_file")',
    );
    expect(source).toContain(
      'targetUrl = `${functionUrl}/api/workspaces/materialize-files`',
    );
    expect(source).toContain("files: isWorkspaceMaterializeFiles");
    expect(source).toContain("traceRequestPayload");
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
