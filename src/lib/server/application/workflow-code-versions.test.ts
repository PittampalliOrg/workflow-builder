import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowCodeVersionService } from "$lib/server/application/workflow-code-versions";
import type {
  SourceBundlePromotionGatePort,
  WorkflowArtifactRecord,
  WorkflowExecutionRecord,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowCodeVersionService", () => {
  let workflowData: ConstructorParameters<
    typeof ApplicationWorkflowCodeVersionService
  >[0]["workflowData"];
  let promotionGate: SourceBundlePromotionGatePort;
  let service: ApplicationWorkflowCodeVersionService;

  beforeEach(() => {
    workflowData = {
      getScopedExecutionById: vi.fn(async () =>
        executionRecord({
          output: { tests: "passed" },
          summaryOutput: { summary: "ok" },
        }),
      ),
      isPlatformAdmin: vi.fn(async () => true),
      listWorkflowArtifactsByExecutionId: vi.fn(async () => [
        sourceBundleArtifact(),
        sourceBundleArtifact({
          id: "artifact-markdown",
          kind: "markdown",
          title: "Summary",
          fileId: null,
          metadata: null,
        }),
      ]),
    };
    promotionGate = {
      evaluatePromotionGate: vi.fn(() => ({ allowed: true, reason: "ok" })),
    };
    service = new ApplicationWorkflowCodeVersionService({
      workflowData,
      promotionGate,
    });
  });

  it("lists source-bundle versions after scoped execution access", async () => {
    await expect(
      service.listVersions({
        executionId: "exec-1",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      status: "ok",
      body: {
        versions: [
          {
            artifactId: "artifact-1",
            executionId: "exec-1",
            nodeId: "agent",
            fileId: "file-1",
            sizeBytes: 123,
            title: "Source bundle",
            payload: { tier: "tar-overlay", base: "main" },
            promotionGate: { allowed: true, reason: "ok" },
            promotion: null,
            acceptance: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        outstanding: true,
        unpromotedCount: 1,
        canManageStrictCheckpoints: true,
        latestStrictArtifactId: null,
      },
    });
    expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(workflowData.isPlatformAdmin).toHaveBeenCalledWith("user-1");
    expect(promotionGate.evaluatePromotionGate).toHaveBeenCalledWith({
      mode: "pr",
      artifactPayload: { tier: "tar-overlay", base: "main" },
      executionOutput: { tests: "passed" },
      summaryOutput: { summary: "ok" },
    });
  });

  it("reports when the scoped user cannot manage strict checkpoints", async () => {
    vi.mocked(workflowData.isPlatformAdmin).mockResolvedValueOnce(false);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "member-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: { canManageStrictCheckpoints: false },
    });
    expect(workflowData.isPlatformAdmin).toHaveBeenCalledWith("member-1");
  });

  it("keeps the run outstanding while any version lacks a durable pull request", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      sourceBundleArtifact({
        metadata: {
          promotion: { prUrl: "https://github.com/owner/repo/pull/1" },
        },
      }),
      sourceBundleArtifact({ id: "artifact-2" }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: { outstanding: true, unpromotedCount: 1 },
    });
  });

  it("does not treat a branch-only promotion as a durable pull request", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      sourceBundleArtifact({
        metadata: { promotion: { branch: "wfb-promote-1" } },
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: { outstanding: true, unpromotedCount: 1 },
    });
  });

  it("reports no outstanding work when every version has a pull request receipt", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      sourceBundleArtifact({
        metadata: {
          promotion: {
            receiptId: "receipt-42",
            repository: "owner/repo",
            pullRequestNumber: 42,
          },
          acceptance: { ok: true },
        },
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: {
        outstanding: false,
        unpromotedCount: 0,
        versions: [{ acceptance: { ok: true } }],
      },
    });
  });

  it("treats older unpromoted strict snapshots as history once the newest is promoted", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      strictSnapshot({
        id: "strict-older",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      }),
      strictSnapshot({
        id: "strict-newest",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
        metadata: {
          promotion: {
            repository: "owner/repo",
            pullRequestNumber: 42,
          },
        },
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: {
        outstanding: false,
        unpromotedCount: 0,
        versions: [{ artifactId: "strict-older" }, { artifactId: "strict-newest" }],
      },
    });
  });

  it("counts only the newest unpromoted strict snapshot", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      strictSnapshot({
        id: "strict-older",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
        metadata: {
          promotion: {
            repository: "owner/repo",
            pullRequestNumber: 41,
          },
        },
      }),
      strictSnapshot({
        id: "strict-newest",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: {
        outstanding: true,
        unpromotedCount: 1,
        latestStrictArtifactId: "strict-newest",
      },
    });
  });

  it("orders versions and selects the latest strict snapshot deterministically when timestamps tie", async () => {
    const createdAt = new Date("2026-01-01T00:00:02.000Z");
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      strictSnapshot({
        id: "strict-z",
        createdAt,
        metadata: {
          promotion: {
            repository: "owner/repo",
            pullRequestNumber: 42,
          },
        },
      }),
      strictSnapshot({ id: "strict-a", createdAt }),
      sourceBundleArtifact({
        id: "legacy-earlier",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
        metadata: {
          promotion: {
            repository: "owner/repo",
            pullRequestNumber: 41,
          },
        },
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: {
        versions: [
          { artifactId: "legacy-earlier" },
          { artifactId: "strict-a" },
          { artifactId: "strict-z" },
        ],
        latestStrictArtifactId: "strict-z",
        outstanding: false,
        unpromotedCount: 0,
      },
    });
  });

  it("keeps non-strict versions independent of a promoted newest strict snapshot", async () => {
    vi.mocked(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).mockResolvedValue([
      sourceBundleArtifact({
        id: "legacy-unpromoted",
        createdAt: new Date("2026-01-01T00:00:03.000Z"),
      }),
      strictSnapshot({
        id: "strict-newest",
        createdAt: new Date("2026-01-01T00:00:02.000Z"),
        metadata: {
          promotion: {
            repository: "owner/repo",
            pullRequestNumber: 42,
          },
        },
      }),
      strictSnapshot({
        id: "strict-history",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
      }),
    ]);

    const result = await service.listVersions({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });

    expect(result).toMatchObject({
      status: "ok",
      body: { outstanding: true, unpromotedCount: 1 },
    });
  });

  it("hides missing or out-of-scope executions before reading artifacts", async () => {
    vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

    await expect(
      service.listVersions({
        executionId: "exec-1",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 404,
      message: "Execution not found",
    });
    expect(
      workflowData.listWorkflowArtifactsByExecutionId,
    ).not.toHaveBeenCalled();
    expect(workflowData.isPlatformAdmin).not.toHaveBeenCalled();
  });
});

function executionRecord(
  overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
  return {
    id: "exec-1",
    workflowId: "workflow-1",
    userId: "user-1",
    projectId: "project-1",
    status: "success",
    input: null,
    output: null,
    executionIrVersion: null,
    executionIr: null,
    error: null,
    daprInstanceId: "instance-1",
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
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    completedAt: null,
    duration: null,
    stopRequestedAt: null,
    stopReason: null,
    ...overrides,
  };
}

function sourceBundleArtifact(
  overrides: Partial<WorkflowArtifactRecord> = {},
): WorkflowArtifactRecord {
  return {
    id: "artifact-1",
    workflowExecutionId: "exec-1",
    nodeId: "agent",
    slot: "aux",
    kind: "source-bundle",
    title: "Source bundle",
    description: null,
    inlinePayload: { tier: "tar-overlay", base: "main" },
    fileId: "file-1",
    contentType: "application/gzip",
    sizeBytes: 123,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function strictSnapshot(
  overrides: Partial<WorkflowArtifactRecord> = {},
): WorkflowArtifactRecord {
  return sourceBundleArtifact({
    inlinePayload: {
      tier: "tar-overlay-set",
      captureProtocol: "atomic-generation-v2",
      acceptanceEligible: true,
    },
    ...overrides,
  });
}
