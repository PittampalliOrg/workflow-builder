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
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        outstanding: true,
      },
    });
    expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(promotionGate.evaluatePromotionGate).toHaveBeenCalledWith({
      mode: "pr",
      artifactPayload: { tier: "tar-overlay", base: "main" },
      executionOutput: { tests: "passed" },
      summaryOutput: { summary: "ok" },
    });
  });

  it("marks the run as not outstanding once any version has durable promotion metadata", async () => {
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
      body: { outstanding: false },
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
