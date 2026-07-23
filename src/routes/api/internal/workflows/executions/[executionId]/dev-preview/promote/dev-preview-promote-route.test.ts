import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePreviewActionInternal: vi.fn(),
  resolveCanonicalExecutionId: vi.fn(async () => "exec-1"),
  getExecutionById: vi.fn(async () => ({
    id: "exec-1",
    userId: "admin-1",
    input: {
      __previewDevelopment: {
        parentExecutionId: "forged-parent-exec",
      },
    },
    executionIr: {
      authority: {
        previewDevelopment: {
          version: 2,
          parentExecutionId: "parent-exec-1",
          remoteActorUserId: "admin-1",
          operationId: `pdt-start-workflow-${"a".repeat(64)}`,
          target: {
            previewName: "preview-one",
            environmentRequestId: "launch-1",
            platformRevision: "b".repeat(40),
            sourceRevision: "c".repeat(40),
            catalogDigest: `sha256:${"d".repeat(64)}`,
          },
          workflowSpecDigest: `sha256:${"e".repeat(64)}`,
        },
      },
    },
  })),
  isPlatformAdmin: vi.fn(async () => true),
  listWorkflowArtifactsByExecutionId: vi.fn(async () => [
    {
      id: "artifact-1",
      kind: "source-bundle",
      fileId: "file-1",
      createdAt: new Date("2026-07-09T20:00:00.000Z"),
      inlinePayload: {
        manifestVersion: 2,
        acceptanceEligible: true,
        captureProtocol: "atomic-generation-v2",
        captureId: "capture-1",
        generation: "generation-1",
        catalogDigest: `sha256:${"d".repeat(64)}`,
        repoUrl: "PittampalliOrg/workflow-builder",
        base: "main",
        tier: "tar-overlay-set",
        services: ["function-router", "workflow-builder"],
        overlayDigests: {
          "function-router": `sha256:${"1".repeat(64)}`,
          "workflow-builder": `sha256:${"2".repeat(64)}`,
        },
        sourceRevision: "b".repeat(40),
        platformRevision: "c".repeat(40),
      },
      metadata: null,
    },
  ]),
  promote: vi.fn(async () => ({
    ok: true as const,
    previewName: "preview-one",
    requestId: "launch-1",
    executionId: "exec-1",
    artifactId: "artifact-1",
    services: ["workflow-builder"],
    prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/1",
    branch: "preview-1",
    commitSha: "c".repeat(40),
    pullRequest: {
      repository: "PittampalliOrg/workflow-builder",
      number: 1,
      baseSha: "b".repeat(40),
      headSha: "c".repeat(40),
    },
    draft: true,
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    workflowData: {
      resolveCanonicalExecutionId: mocks.resolveCanonicalExecutionId,
      getExecutionById: mocks.getExecutionById,
      isPlatformAdmin: mocks.isPlatformAdmin,
      listWorkflowArtifactsByExecutionId:
        mocks.listWorkflowArtifactsByExecutionId,
    },
    previewSourcePromotion: { promote: mocks.promote },
  }),
}));

import { POST } from "./+server";

function event() {
  return {
    params: { executionId: "exec-1" },
    request: new Request("http://localhost/internal/promote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ iteration: "best", draft: true }),
    }),
  };
}

describe("dev-preview strict source promotion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands only the selected immutable artifact to the physical promotion service", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith({
      executionId: "exec-1",
      hostExecutionId: "parent-exec-1",
      artifactId: "artifact-1",
      title: null,
      bodyMarkdown: null,
      draft: true,
    });
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("reports a physical broker failure as workflow data", async () => {
    mocks.promote.mockRejectedValueOnce(new Error("broker unavailable"));
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "source_promotion_failed: broker unavailable",
    });
  });

  it("never derives a host execution from workflow-controlled input", async () => {
    mocks.getExecutionById.mockResolvedValueOnce({
      id: "exec-1",
      userId: "admin-1",
      input: {
        __previewDevelopment: {
          parentExecutionId: "forged-parent-exec",
        },
      },
      executionIr: {
        authority: {
          previewDevelopment: {
            version: 2,
            parentExecutionId: "../invalid",
            remoteActorUserId: "admin-1",
            operationId: `pdt-start-workflow-${"a".repeat(64)}`,
            target: {
              previewName: "preview-one",
              environmentRequestId: "launch-1",
              platformRevision: "b".repeat(40),
              sourceRevision: "c".repeat(40),
              catalogDigest: `sha256:${"d".repeat(64)}`,
            },
            workflowSpecDigest: `sha256:${"e".repeat(64)}`,
          },
        },
      },
    });

    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith({
      executionId: "exec-1",
      hostExecutionId: null,
      artifactId: "artifact-1",
      title: null,
      bodyMarkdown: null,
      draft: true,
    });
  });

  it("rejects repository and branch authority from the caller", async () => {
    const request = event();
    request.request = new Request("http://localhost/internal/promote", {
      method: "POST",
      body: JSON.stringify({
        iteration: "best",
        repoUrl: "attacker/repo",
        baseBranch: "attacker",
      }),
    });
    const response = (await POST(request as never)) as Response;
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported promotion fields"),
    });
    expect(mocks.promote).not.toHaveBeenCalled();
  });
});
