import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewSessionContinuationService } from "$lib/server/application/preview-session-continuation";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);
const CATALOG_DIGEST = `sha256:${"e".repeat(64)}` as const;

function harness(overrides: Record<string, unknown> = {}) {
  const workflowData = {
    getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
    isPlatformAdmin: vi.fn(async () => true),
  };
  const identity = {
    current: vi.fn(() => ({
      previewName: "preview-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: PLATFORM_SHA,
      environmentSourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
    })),
  };
  const capture = {
    captureAcceptanceCandidate: vi.fn(async () => ({
      ok: true,
      artifactId: "artifact-capture",
      bytes: 42,
      captureId: "capture-1",
      generation: "generation-1",
      services: [{ service: "workflow-builder", ok: true }],
    })),
  };
  const promotion = {
    promote: vi.fn(async () => ({
      ok: true,
      previewName: "preview-one",
      requestId: "request-1",
      executionId: "execution-1",
      artifactId: "central-artifact-promotion",
      services: ["workflow-builder"],
      branch: "preview-feature-artifact-promotion",
      commitSha: HEAD_SHA,
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
      draft: true,
    })),
  };
  const acceptance = {
    replay: vi.fn(async () => ({
      ok: true,
      name: "accept-pr42-dddddddddddd",
      previewName: "preview-one",
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
      services: ["workflow-builder"],
      images: [
        {
          service: "workflow-builder",
          sourceRevision: HEAD_SHA,
          imageRef: `ghcr.io/pittampalliorg/workflow-builder:git-${HEAD_SHA}`,
          digest: `sha256:${"f".repeat(64)}`,
          immutableRef: `ghcr.io/pittampalliorg/workflow-builder@sha256:${"f".repeat(64)}`,
          buildId: "build-1",
        },
      ],
      evidenceReceiptDigest: `sha256:${"1".repeat(64)}`,
    })),
  };
  const service = new ApplicationPreviewSessionContinuationService({
    workflowData: workflowData as never,
    identity,
    capture,
    promotion: promotion as never,
    acceptance: acceptance as never,
    requestId: () => "continuation-request-1",
    ...overrides,
  });
  return { service, workflowData, identity, capture, promotion, acceptance };
}

function input(action: unknown) {
  return {
    executionId: "execution-1",
    userId: "admin-1",
    projectId: "project-1",
    action,
  };
}

describe("ApplicationPreviewSessionContinuationService", () => {
  it("scopes an actor/project capture and binds capture provenance to the local preview identity", async () => {
    const h = harness();

    await expect(
      h.service.continue(
        input({
          action: "capture",
          services: ["workflow-builder", "function-router"],
          iteration: 3,
        }),
      ),
    ).resolves.toEqual({
      status: "ok",
      httpStatus: 200,
      body: {
        action: "capture",
        ok: true,
        artifactId: "artifact-capture",
        services: [{ service: "workflow-builder", ok: true }],
      },
    });

    expect(h.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "execution-1",
      userId: "admin-1",
      projectId: "project-1",
    });
    expect(h.workflowData.isPlatformAdmin).toHaveBeenCalledWith("admin-1");
    expect(h.capture.captureAcceptanceCandidate).toHaveBeenCalledWith({
      executionId: "execution-1",
      nodeId: "preview-session-continuation",
      iteration: 3,
      expectedServices: ["workflow-builder", "function-router"],
      platformRevision: PLATFORM_SHA,
      sourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
    });
  });

  it("returns the transferred promotion artifact while withholding broker provenance from the public result", async () => {
    const h = harness();

    const result = await h.service.continue(
      input({
        action: "promote",
        artifactId: "source-artifact-promotion",
        title: "Preview change",
        bodyMarkdown: "Promote the verified capture.",
        draft: true,
      }),
    );

    expect(h.promotion.promote).toHaveBeenCalledWith({
      executionId: "execution-1",
      artifactId: "source-artifact-promotion",
      title: "Preview change",
      bodyMarkdown: "Promote the verified capture.",
      draft: true,
    });
    expect(result).toEqual({
      status: "ok",
      httpStatus: 200,
      body: {
        action: "promote",
        ok: true,
        artifactId: "central-artifact-promotion",
        services: ["workflow-builder"],
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
        },
        draft: true,
      },
    });
    const publicResult = JSON.stringify(result);
    expect(publicResult).not.toContain(BASE_SHA);
    expect(publicResult).not.toContain(HEAD_SHA);
    expect(publicResult).not.toContain("preview-feature-artifact-promotion");
    expect(publicResult).not.toContain("github.com");
    expect(publicResult).not.toContain("request-1");
  });

  it("uses the exact local identity for immutable acceptance and strips image and revision fields", async () => {
    const h = harness();

    const result = await h.service.continue(
      input({
        action: "acceptance",
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
        },
      }),
    );

    expect(h.acceptance.replay).toHaveBeenCalledWith({
      requestId: "continuation-request-1",
      previewName: "preview-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: PLATFORM_SHA,
      environmentSourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    });
    expect(result).toEqual({
      status: "ok",
      httpStatus: 200,
      body: {
        action: "acceptance",
        ok: true,
        services: ["workflow-builder"],
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
        },
      },
    });
    const publicResult = JSON.stringify(result);
    for (const secretOrProvenance of [
      PLATFORM_SHA,
      SOURCE_SHA,
      BASE_SHA,
      HEAD_SHA,
      "ghcr.io",
      "sha256:",
      "continuation-request-1",
    ]) {
      expect(publicResult).not.toContain(secretOrProvenance);
    }
  });

  it("rejects unknown authority fields before reading the execution or local identity", async () => {
    const h = harness();

    await expect(
      h.service.continue(
        input({
          action: "capture",
          services: ["workflow-builder"],
          platformRevision: PLATFORM_SHA,
        }),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 400,
      message: "Invalid preview continuation action",
    });
    expect(h.workflowData.getScopedExecutionById).not.toHaveBeenCalled();
    expect(h.identity.current).not.toHaveBeenCalled();
  });

  it("returns scope and actor-admin failures before invoking any preview port", async () => {
    const outOfScope = harness({
      workflowData: {
        getScopedExecutionById: vi.fn(async () => null),
        isPlatformAdmin: vi.fn(async () => true),
      },
    });
    await expect(
      outOfScope.service.continue(
        input({ action: "capture", services: ["workflow-builder"] }),
      ),
    ).resolves.toMatchObject({ status: "error", httpStatus: 404 });
    expect(outOfScope.capture.captureAcceptanceCandidate).not.toHaveBeenCalled();

    const notAdmin = harness({
      workflowData: {
        getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
        isPlatformAdmin: vi.fn(async () => false),
      },
    });
    await expect(
      notAdmin.service.continue(
        input({ action: "capture", services: ["workflow-builder"] }),
      ),
    ).resolves.toMatchObject({ status: "error", httpStatus: 403 });
    expect(notAdmin.identity.current).not.toHaveBeenCalled();
    expect(notAdmin.capture.captureAcceptanceCandidate).not.toHaveBeenCalled();
  });
});
