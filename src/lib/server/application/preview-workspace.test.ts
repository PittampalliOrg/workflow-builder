import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewWorkspaceService } from "./preview-workspace";
import type {
  PreviewControlIdentity,
  PreviewWorkspaceSourcePlan,
  WorkflowExecutionRecord,
} from "./ports";

const SOURCE = "c".repeat(40);
const IDENTITY: PreviewControlIdentity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "b".repeat(40),
  environmentSourceRevision: SOURCE,
  catalogDigest: `sha256:${"a".repeat(64)}`,
};
const SOURCE_PLAN: PreviewWorkspaceSourcePlan = {
  service: "workflow-builder",
  repository: "PittampalliOrg/workflow-builder",
  repoSubdir: ".",
  syncPaths: ["src", "package.json"],
  stageMappings: [],
  allowedCommands: ["check"],
};

function execution(
  overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
  return {
    id: "exec-1",
    workflowId: "workflow-1",
    userId: "admin-1",
    projectId: "project-1",
    status: "running",
    input: {
      services: ["workflow-builder"],
      diffScope: [
        "src/routes/(admin)/admin/drasi",
        "src/routes/api/executions/[executionId]",
      ],
    },
    output: null,
    executionIrVersion: "dynamic-script/v1",
    executionIr: {
      engine: "dynamic-script",
      authority: {
        previewWorkspace: {
          version: 1,
          target: {
            previewName: IDENTITY.previewName,
            environmentRequestId: IDENTITY.environmentRequestId,
            platformRevision: IDENTITY.environmentPlatformRevision,
            sourceRevision: IDENTITY.environmentSourceRevision,
            catalogDigest: IDENTITY.catalogDigest,
          },
        },
      },
    },
    error: null,
    daprInstanceId: "script-1",
    phase: null,
    progress: null,
    currentNodeId: null,
    currentNodeName: null,
    primaryTraceId: null,
    workflowSessionId: null,
    mlflowExperimentId: null,
    mlflowRunId: null,
    summaryOutput: null,
    errorStackTrace: null,
    rerunOfExecutionId: null,
    rerunSourceInstanceId: null,
    resumeFromNode: null,
    triggerSource: null,
    rerunFromEventId: null,
    startedAt: new Date(),
    completedAt: null,
    duration: null,
    stopRequestedAt: null,
    stopReason: null,
    ...overrides,
  };
}

function harness(
  row = execution(),
  localIdentity: PreviewControlIdentity = IDENTITY,
  deployment: "preview" | "control-plane" = "preview",
) {
  const seed = vi.fn(async () => ({ reused: false, fileCount: 42 }));
  const capture = vi.fn(async () => ({
    archive: new Uint8Array([1, 2, 3]),
    archiveSha256: `sha256:${"d".repeat(64)}` as const,
    changedPaths: ["src/routes/(admin)/admin/drasi/+page.svelte"],
    fileCount: 1,
  }));
  const sync = vi.fn(
    async (_input: { generation?: string; mode?: "merge" | "replace" }) => ({
      service: "workflow-builder",
      result: {
        ok: true as const,
        data: {
          ok: true,
          status: 200,
          bytes: 3,
          body: {
            generation: "",
            contentSha256: `sha256:${"e".repeat(64)}`,
            changedPathCount: 1,
            changedPaths: ["src/routes/(admin)/admin/drasi/+page.svelte"],
            timingsMs: { total: 12 },
          },
        },
      },
    }),
  );
  const run = vi.fn(async () => ({
    service: "workflow-builder",
    cmd: "check",
    result: {
      ok: true as const,
      data: {
        ok: true,
        cmd: "check",
        exitCode: 0,
        durationMs: 10,
        truncated: false,
        output: "ok",
        executedIn: "app" as const,
      },
    },
  }));
  const service = new ApplicationPreviewWorkspaceService({
    getExecution: async () => row,
    isPlatformAdmin: async () => true,
    identity: { current: () => localIdentity },
    scope: {
      current: () =>
        deployment === "control-plane"
          ? ({ kind: "control-plane" } as const)
          : ({
              kind: "preview",
              preview: {
                name: localIdentity.previewName,
                profile: "app-live",
                platformRevision: localIdentity.environmentPlatformRevision,
                sourceRevision: localIdentity.environmentSourceRevision,
                origin: "https://wfb-feature-one.tail286401.ts.net",
              },
            } as const),
      isControlPlane: () => deployment === "control-plane",
      allowsPreviewName: (name) => name === localIdentity.previewName,
    },
    catalog: { resolve: () => SOURCE_PLAN },
    workspace: { seed, capture },
    sidecar: {
      status: async () => ({
        service: "workflow-builder",
        status: {
          ok: true,
          data: { ok: true, frozen: false, prepared: false },
        },
        allowedCommands: ["check"],
      }),
      sync,
      run,
      allowedCommands: () => ["check"],
    },
  });
  return { service, seed, capture, sync, run };
}

describe("ApplicationPreviewWorkspaceService", () => {
  it("derives the canonical workspace and exact source revision for seed", async () => {
    const h = harness();
    await expect(
      h.service.seed({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "seed-1",
      }),
    ).resolves.toMatchObject({
      receiptMode: "credentialless",
      sourceRevision: SOURCE,
      workspace: "ready",
    });
    expect(h.seed).toHaveBeenCalledWith({
      executionId: "exec-1",
      workspaceKey: "ws_script_exec-1",
      repository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE,
      repoSubdir: ".",
    });
  });

  it("passes only server-derived scope and a stable generation to sync", async () => {
    const h = harness();
    const result = await h.service.sync({
      executionId: "exec-1",
      service: "workflow-builder",
      operationId: "checkpoint-1",
    });
    expect(h.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: "ws_script_exec-1",
        diffScope: [
          "src/routes/(admin)/admin/drasi",
          "src/routes/api/executions/[executionId]",
        ],
      }),
    );
    const call = h.sync.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("syncUrl");
    expect(call).not.toHaveProperty("token");
    expect(call?.generation).toMatch(/^pws-[0-9a-f]{64}$/);
    expect(call?.mode).toBe("replace");
    expect(result.fileCount).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/syncUrl|syncCapability|token/i);
  });

  it("rejects an archive with a changed path outside persisted diffScope", async () => {
    const h = harness();
    h.capture.mockResolvedValueOnce({
      archive: new Uint8Array([1]),
      archiveSha256: `sha256:${"d".repeat(64)}`,
      changedPaths: ["src/routes/api/unrelated/+server.ts"],
      fileCount: 1,
    });
    await expect(
      h.service.sync({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "checkpoint-2",
      }),
    ).rejects.toThrow("outside the execution diff scope");
    expect(h.sync).not.toHaveBeenCalled();
  });

  it("rejects a replaced local tuple before touching the workspace", async () => {
    const h = harness(execution(), {
      ...IDENTITY,
      previewName: "replacement",
    });
    await expect(
      h.service.seed({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "seed-2",
      }),
    ).rejects.toThrow("does not match the local environment");
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("ignores a forged input binding and requires execution IR authority", async () => {
    const row = execution({
      input: {
        services: ["workflow-builder"],
        diffScope: ["src/routes/(admin)/admin/drasi"],
        __previewDevelopment: {
          target: {
            previewName: IDENTITY.previewName,
            environmentRequestId: IDENTITY.environmentRequestId,
            platformRevision: IDENTITY.environmentPlatformRevision,
            sourceRevision: IDENTITY.environmentSourceRevision,
            catalogDigest: IDENTITY.catalogDigest,
          },
        },
      },
      executionIr: {
        engine: "dynamic-script",
        args: {},
      },
    });
    const h = harness(row);

    await expect(
      h.service.seed({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "seed-forged",
      }),
    ).rejects.toThrow("no immutable preview workspace authority");
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("rejects execution IR authority outside an app-live preview scope", async () => {
    const h = harness(execution(), IDENTITY, "control-plane");

    await expect(
      h.service.seed({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "seed-control-plane",
      }),
    ).rejects.toThrow("require an app-live preview deployment");
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("requires a non-empty persisted diff scope before seeding", async () => {
    const row = execution({
      input: {
        ...(execution().input as Record<string, unknown>),
        diffScope: null,
      },
    });
    const h = harness(row);
    await expect(
      h.service.seed({
        executionId: "exec-1",
        service: "workflow-builder",
        operationId: "seed-3",
      }),
    ).rejects.toThrow("require a persisted diff scope");
    expect(h.seed).not.toHaveBeenCalled();
  });

  it("double-checks the catalog and receiver command allowlists", async () => {
    const h = harness();
    await expect(
      h.service.run({
        executionId: "exec-1",
        service: "workflow-builder",
        command: "check",
        operationId: "run-1",
      }),
    ).resolves.toMatchObject({ ok: true, command: "check" });
    expect(h.run).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15 * 60_000 }),
    );
    await expect(
      h.service.run({
        executionId: "exec-1",
        service: "workflow-builder",
        command: "arbitrary-shell",
        operationId: "run-2",
      }),
    ).rejects.toThrow("not allowlisted");
  });
});
