import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowCodeVersionPromotionService } from "$lib/server/application/workflow-code-version-promotion";
import type {
  SourceBundlePromotionGatePort,
  SourceBundlePromotionRunnerPort,
  WorkflowArtifactRecord,
  WorkflowExecutionRecord,
} from "$lib/server/application/ports";

describe("ApplicationWorkflowCodeVersionPromotionService", () => {
  let workflowData: ConstructorParameters<
    typeof ApplicationWorkflowCodeVersionPromotionService
  >[0]["workflowData"];
  let promotionGate: SourceBundlePromotionGatePort;
  let runner: SourceBundlePromotionRunnerPort;
  let service: ApplicationWorkflowCodeVersionPromotionService;

  beforeEach(() => {
    workflowData = {
      getScopedExecutionById: vi.fn(async () => executionRecord()),
      getWorkflowArtifactForExecution: vi.fn(async () =>
        sourceBundleArtifact(),
      ),
      updateWorkflowArtifactMetadata: vi.fn(async () =>
        sourceBundleArtifact({
          metadata: {
            previous: true,
            promotion: { branch: "wfb-promote-1" },
          },
        }),
      ),
    };
    promotionGate = {
      evaluatePromotionGate: vi.fn(() => ({
        allowed: true,
        reason: "ok",
      })),
    };
    runner = {
      promoteSourceBundle: vi.fn(async () => ({
        status: "ok" as const,
        output: "BRANCH_PUSHED=wfb-promote-1\n",
        prUrl: null,
        branch: "wfb-promote-1",
        commitSha: "a".repeat(40),
        baseRevision: null,
        pullRequestBase: "main",
        changedPaths: [],
        prError: null,
      })),
    };
    service = new ApplicationWorkflowCodeVersionPromotionService({
      workflowData,
      promotionGate,
      runner,
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });
  });

  it("promotes a source bundle and records durable promotion metadata", async () => {
    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {
          mode: "branch",
          repo: "https://github.com/body/repo.git",
        },
      }),
    ).resolves.toMatchObject({
      status: "ok",
      body: {
        ok: true,
        mode: "branch",
        repo: "body/repo",
        base: "main",
        tier: "tar-overlay",
        branch: "wfb-promote-1",
      },
    });

    expect(workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "exec-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(runner.promoteSourceBundle).toHaveBeenCalledWith({
      executionId: "exec-1",
      fileId: "file-1",
      repo: "body/repo",
      base: "main",
      mode: "branch",
      title: "Promoted change (workflow-builder)",
      tier: "tar-overlay",
      repoSubdir: "",
      syncPaths: ["src"],
    });
    expect(workflowData.updateWorkflowArtifactMetadata).toHaveBeenCalledWith({
      executionId: "exec-1",
      artifactId: "artifact-1",
      metadata: {
        previous: true,
        promotion: {
          prUrl: null,
          branch: "wfb-promote-1",
          commitSha: "a".repeat(40),
          mode: "branch",
          repo: "body/repo",
          base: "main",
          promotedAt: "2026-01-02T03:04:05.000Z",
          promotedBy: "user-1",
        },
      },
    });
  });

  it("hides missing or out-of-scope executions before reading artifacts", async () => {
    vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(null);

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 404,
      message: "Execution not found",
    });
    expect(workflowData.getWorkflowArtifactForExecution).not.toHaveBeenCalled();
    expect(runner.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("rejects non-source-bundle artifacts", async () => {
    vi.mocked(
      workflowData.getWorkflowArtifactForExecution,
    ).mockResolvedValueOnce(sourceBundleArtifact({ kind: "markdown" }));

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 404,
      message: "Source-bundle version not found",
    });
    expect(runner.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("rejects strict atomic preview captures before the generic promotion path", async () => {
    vi.mocked(
      workflowData.getWorkflowArtifactForExecution,
    ).mockResolvedValueOnce(
      sourceBundleArtifact({
        inlinePayload: {
          tier: "tar-overlay-set",
          captureProtocol: "atomic-generation-v2",
          acceptanceEligible: true,
          repoUrl: "https://github.com/owner/repo.git",
          base: "main",
          sourceRevision: "b".repeat(40),
        },
      }),
    );

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: { mode: "pr" },
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message:
        "Strict preview captures must be promoted through preview continuation",
    });
    expect(promotionGate.evaluatePromotionGate).not.toHaveBeenCalled();
    expect(runner.promoteSourceBundle).not.toHaveBeenCalled();
    expect(workflowData.updateWorkflowArtifactMetadata).not.toHaveBeenCalled();
  });

  it("returns the existing bad request when no target repo can be resolved", async () => {
    vi.mocked(workflowData.getScopedExecutionById).mockResolvedValueOnce(
      executionRecord({ input: {} }),
    );
    vi.mocked(
      workflowData.getWorkflowArtifactForExecution,
    ).mockResolvedValueOnce(
      sourceBundleArtifact({ inlinePayload: { tier: "full" } }),
    );

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message:
        "Target repo could not be resolved — pass { repo: 'owner/name' }",
    });
    expect(runner.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("returns gate failure without provisioning promotion runner work", async () => {
    vi.mocked(promotionGate.evaluatePromotionGate).mockReturnValueOnce({
      allowed: false,
      reason: "missing checks",
    });

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "ok",
      httpStatus: 409,
      body: {
        ok: false,
        error: "promotion_gate_failed",
        promotionGate: { allowed: false, reason: "missing checks" },
      },
    });
    expect(runner.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("maps runner unavailability to a 502 error", async () => {
    vi.mocked(runner.promoteSourceBundle).mockResolvedValueOnce({
      status: "unavailable",
      message: "promote command failed (no pod response)",
    });

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 502,
      message: "promote command failed (no pod response)",
    });
  });

  it("maps command marker errors to 502 JSON without metadata persistence", async () => {
    vi.mocked(runner.promoteSourceBundle).mockResolvedValueOnce({
      status: "command_error",
      error: "no_github_token",
      output: "ERR=no_github_token\n",
    });

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toEqual({
      status: "ok",
      httpStatus: 502,
      body: {
        ok: false,
        error: "no_github_token",
        output: "ERR=no_github_token\n",
      },
    });
    expect(workflowData.updateWorkflowArtifactMetadata).not.toHaveBeenCalled();
  });

  it("keeps PR API failures as ok responses without metadata persistence", async () => {
    vi.mocked(runner.promoteSourceBundle).mockResolvedValueOnce({
      status: "ok",
      output: 'PR_ERR="message":"Validation Failed"\n',
      prUrl: null,
      branch: null,
      commitSha: "b".repeat(40),
      baseRevision: null,
      pullRequestBase: "main",
      changedPaths: [],
      prError: '"message":"Validation Failed"',
    });

    await expect(
      service.promote({
        executionId: "exec-1",
        artifactId: "artifact-1",
        userId: "user-1",
        projectId: "project-1",
        body: {},
      }),
    ).resolves.toMatchObject({
      status: "ok",
      body: {
        ok: true,
        prUrl: null,
        branch: null,
        prError: '"message":"Validation Failed"',
      },
    });
    expect(workflowData.updateWorkflowArtifactMetadata).not.toHaveBeenCalled();
  });
});

function executionRecord(
  overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
  return {
    id: "exec-1",
    workflowId: "wf-1",
    userId: "user-1",
    projectId: "project-1",
    status: "success",
    input: {
      repoUrl: "https://github.com/fallback/repo.git",
      repoRef: "main",
    },
    output: { result: "ok" },
    executionIrVersion: null,
    executionIr: null,
    error: null,
    daprInstanceId: "exec-1",
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
    inlinePayload: {
      tier: "tar-overlay",
      repoUrl: "https://github.com/owner/repo.git",
      base: "main",
      repoSubdir: ".",
      syncPaths: ["src"],
    },
    fileId: "file-1",
    contentType: "application/gzip",
    sizeBytes: 123,
    metadata: { previous: true },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}
