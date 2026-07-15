import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewSessionContinuationService } from "$lib/server/application/preview-session-continuation";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);
const LIVE_BASE_SHA = "2".repeat(40);
const CATALOG_DIGEST = `sha256:${"e".repeat(64)}` as const;
const RECEIPT_ID = `pspr_${"f".repeat(64)}`;
const EVIDENCE_RECEIPT_DIGEST = `sha256:${"1".repeat(64)}` as const;

function cleanupProof() {
  return {
    name: "accept-pr42-dddddddddddd",
    resourceName: "accept-pr42-dddddddddddd",
    complete: true,
    phase: "complete" as const,
    checks: {
      "runner-succeeded": true,
      "preview-environment-absent": true,
      "application-absent": true,
      "agent-registration-absent": true,
      "agent-namespaces-absent": true,
      "database-absent": true,
      "nats-stream-absent": true,
      "headlamp-registration-absent": true,
      "tailnet-egress-absent": true,
      "host-namespace-absent": true,
      "storage-scope-absent": true,
      "runner-identity-absent": true,
    },
    message: null,
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const artifact = {
    id: "source-artifact-promotion",
    workflowExecutionId: "execution-1",
    kind: "source-bundle",
    fileId: "file-1",
    inlinePayload: {
      tier: "tar-overlay-set",
      captureProtocol: "atomic-generation-v2",
      acceptanceEligible: true,
    },
    createdAt: new Date("2026-07-14T11:00:00.000Z"),
    metadata: {
      existing: "kept",
      promotion: {
        receiptId: RECEIPT_ID,
        repository: "PittampalliOrg/workflow-builder",
        pullRequestNumber: 42,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
      },
    },
  };
  const workflowData = {
    getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
    isPlatformAdmin: vi.fn(async () => true),
    getWorkflowArtifactForExecution: vi.fn(async () => artifact as never),
    listWorkflowArtifactsByExecutionId: vi.fn(async () => [artifact] as never),
    mergeWorkflowArtifactMetadata: vi.fn(async () => artifact as never),
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
      receiptId: RECEIPT_ID,
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
        baseSha: LIVE_BASE_SHA,
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
      verification: {
        ok: true,
        checks: [
          { name: "ui-ready", ok: true, detail: "HTTP 200" },
          { name: "workflow-api-ready", ok: true },
        ],
      },
      cleanup: cleanupProof(),
      evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
    })),
  };
  const service = new ApplicationPreviewSessionContinuationService({
    workflowData: workflowData as never,
    identity,
    capture,
    promotion: promotion as never,
    acceptance: acceptance as never,
    requestId: () => "continuation-request-1",
    now: () => new Date("2026-07-14T12:00:00.000Z"),
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
        bytes: 42,
        captureId: "capture-1",
        generation: "generation-1",
        services: [{ service: "workflow-builder", ok: true }],
      },
    });

    expect(h.workflowData.getScopedExecutionById).toHaveBeenCalledWith({
      executionId: "execution-1",
      userId: "admin-1",
      projectId: "project-1",
    });
    expect(h.workflowData.isPlatformAdmin).not.toHaveBeenCalled();
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

  it("persists the verified receipt on the local artifact and returns its canonical PR", async () => {
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
        artifactId: "source-artifact-promotion",
        receiptId: RECEIPT_ID,
        services: ["workflow-builder"],
        branch: "preview-feature-artifact-promotion",
        prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
        },
        draft: true,
      },
    });
    expect(h.workflowData.mergeWorkflowArtifactMetadata).toHaveBeenCalledWith({
      executionId: "execution-1",
      artifactId: "source-artifact-promotion",
      patch: {
        promotion: {
          receiptId: RECEIPT_ID,
          centralArtifactId: "central-artifact-promotion",
          prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
          branch: "preview-feature-artifact-promotion",
          commitSha: HEAD_SHA,
          repository: "PittampalliOrg/workflow-builder",
          pullRequestNumber: 42,
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
          draft: true,
          services: ["workflow-builder"],
          mode: "pr",
          promotedAt: "2026-07-14T12:00:00.000Z",
          promotedBy: "admin-1",
        },
      },
    });
    const publicResult = JSON.stringify(result);
    expect(publicResult).not.toContain(BASE_SHA);
    expect(publicResult).not.toContain(HEAD_SHA);
    expect(publicResult).not.toContain("request-1");
  });

  it("resolves immutable acceptance from the server-side opaque receipt", async () => {
    const h = harness();

    const result = await h.service.continue(
      input({
        action: "acceptance",
        artifactId: "source-artifact-promotion",
      }),
    );

    expect(h.acceptance.replay).toHaveBeenCalledWith({
      requestId: "continuation-request-1",
      previewName: "preview-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: PLATFORM_SHA,
      environmentSourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
      executionId: "execution-1",
      receiptId: RECEIPT_ID,
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
        evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
        verification: {
          ok: true,
          checks: [
            { name: "ui-ready", ok: true, detail: "HTTP 200" },
            { name: "workflow-api-ready", ok: true },
          ],
        },
        cleanup: cleanupProof(),
      },
    });
    const publicResult = JSON.stringify(result);
    for (const secretOrProvenance of [
      PLATFORM_SHA,
      SOURCE_SHA,
      BASE_SHA,
      LIVE_BASE_SHA,
      HEAD_SHA,
      "ghcr.io",
      "continuation-request-1",
    ]) {
      expect(publicResult).not.toContain(secretOrProvenance);
    }
    expect(h.workflowData.mergeWorkflowArtifactMetadata).toHaveBeenCalledWith({
      executionId: "execution-1",
      artifactId: "source-artifact-promotion",
      patch: expect.objectContaining({
        acceptance: expect.objectContaining({
          receiptId: RECEIPT_ID,
          baseSha: LIVE_BASE_SHA,
          headSha: HEAD_SHA,
          ok: true,
          evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
          verification: {
            ok: true,
            checks: [
              { name: "ui-ready", ok: true, detail: "HTTP 200" },
              { name: "workflow-api-ready", ok: true },
            ],
          },
          cleanup: cleanupProof(),
        }),
      }),
    });
  });

  it("persists and returns actionable acceptance failure evidence", async () => {
    const h = harness();
    vi.mocked(h.acceptance.replay).mockResolvedValueOnce({
      ok: false,
      name: "accept-pr42-dddddddddddd",
      previewName: "preview-one",
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: LIVE_BASE_SHA,
        headSha: HEAD_SHA,
      },
      services: ["workflow-builder"],
      verification: {
        ok: false,
        checks: [
          {
            name: "workflow-api-ready",
            ok: false,
            detail: "health probe returned HTTP 503",
          },
        ],
      },
      cleanup: cleanupProof(),
      evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
      stage: "verification",
      message: "Acceptance health verification failed",
    } as never);

    const result = await h.service.continue(
      input({
        action: "acceptance",
        artifactId: "source-artifact-promotion",
      }),
    );

    expect(result).toEqual({
      status: "ok",
      httpStatus: 422,
      body: {
        action: "acceptance",
        ok: false,
        services: ["workflow-builder"],
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
        },
        stage: "verification",
        message: "Acceptance health verification failed",
        evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
        verification: {
          ok: false,
          checks: [
            {
              name: "workflow-api-ready",
              ok: false,
              detail: "health probe returned HTTP 503",
            },
          ],
        },
        cleanup: cleanupProof(),
      },
    });
    expect(h.workflowData.mergeWorkflowArtifactMetadata).toHaveBeenCalledWith({
      executionId: "execution-1",
      artifactId: "source-artifact-promotion",
      patch: {
        acceptance: {
          receiptId: RECEIPT_ID,
          baseSha: LIVE_BASE_SHA,
          headSha: HEAD_SHA,
          ok: false,
          services: ["workflow-builder"],
          evidenceReceiptDigest: EVIDENCE_RECEIPT_DIGEST,
          stage: "verification",
          message: "Acceptance health verification failed",
          verification: {
            ok: false,
            checks: [
              {
                name: "workflow-api-ready",
                ok: false,
                detail: "health probe returned HTTP 503",
              },
            ],
          },
          cleanup: cleanupProof(),
          completedAt: "2026-07-14T12:00:00.000Z",
        },
      },
    });
  });

  it.each(["promote", "acceptance"])(
    "keeps a historical strict checkpoint read-only for %s",
    async (action) => {
      const older = {
        id: "source-artifact-history",
        workflowExecutionId: "execution-1",
        kind: "source-bundle",
        fileId: "file-history",
        inlinePayload: {
          tier: "tar-overlay-set",
          captureProtocol: "atomic-generation-v2",
          acceptanceEligible: true,
        },
        createdAt: new Date("2026-07-14T10:00:00.000Z"),
        metadata: {
          promotion: {
            receiptId: "pspr_history1",
            repository: "PittampalliOrg/workflow-builder",
            pullRequestNumber: 42,
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
          },
        },
      };
      const latest = {
        ...older,
        id: "source-artifact-latest",
        // A partial newest capture must still make all older snapshots history.
        fileId: null,
        createdAt: new Date("2026-07-14T11:00:00.000Z"),
      };
      const h = harness({
        workflowData: {
          getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
          isPlatformAdmin: vi.fn(async () => true),
          getWorkflowArtifactForExecution: vi.fn(async () => older),
          listWorkflowArtifactsByExecutionId: vi.fn(async () => [older, latest]),
          mergeWorkflowArtifactMetadata: vi.fn(async () => null),
        },
      });

      await expect(
        h.service.continue(
          input(
            action === "promote"
              ? {
                  action,
                  artifactId: older.id,
                  draft: true,
                }
              : { action, artifactId: older.id },
          ),
        ),
      ).resolves.toEqual({
        status: "error",
        httpStatus: 409,
        message: "Historical source checkpoints are read-only",
      });
      expect(h.promotion.promote).not.toHaveBeenCalled();
      expect(h.acceptance.replay).not.toHaveBeenCalled();
    },
  );

  it("uses the artifact ID tie-breaker for strict checkpoint commands", async () => {
    const createdAt = new Date("2026-07-14T11:00:00.000Z");
    const strictArtifact = (id: string) => ({
      id,
      workflowExecutionId: "execution-1",
      kind: "source-bundle",
      fileId: `file-${id}`,
      inlinePayload: {
        tier: "tar-overlay-set",
        captureProtocol: "atomic-generation-v2",
        acceptanceEligible: true,
      },
      createdAt,
      metadata: {
        promotion: {
          receiptId: RECEIPT_ID,
          repository: "PittampalliOrg/workflow-builder",
          pullRequestNumber: 42,
          baseSha: BASE_SHA,
          headSha: HEAD_SHA,
        },
      },
    });
    const historical = strictArtifact("source-artifact-a");
    const latest = strictArtifact("source-artifact-z");
    const dataFor = (selected: typeof latest) => ({
      getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
      isPlatformAdmin: vi.fn(async () => true),
      getWorkflowArtifactForExecution: vi.fn(async () => selected),
      // Deliberately return the lexically-latest artifact first.
      listWorkflowArtifactsByExecutionId: vi.fn(async () => [latest, historical]),
      mergeWorkflowArtifactMetadata: vi.fn(async () => selected),
    });

    const current = harness({ workflowData: dataFor(latest) });
    await expect(
      current.service.continue(
        input({ action: "acceptance", artifactId: latest.id }),
      ),
    ).resolves.toMatchObject({ status: "ok", httpStatus: 200 });
    expect(current.acceptance.replay).toHaveBeenCalledTimes(1);

    const old = harness({ workflowData: dataFor(historical) });
    await expect(
      old.service.continue(
        input({ action: "acceptance", artifactId: historical.id }),
      ),
    ).resolves.toEqual({
      status: "error",
      httpStatus: 409,
      message: "Historical source checkpoints are read-only",
    });
    expect(old.acceptance.replay).not.toHaveBeenCalled();
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

  it("allows scoped captures but requires admin for promotion and acceptance", async () => {
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
        getWorkflowArtifactForExecution: vi.fn(async () => null),
        mergeWorkflowArtifactMetadata: vi.fn(async () => null),
      },
    });
    await expect(
      notAdmin.service.continue(
        input({ action: "capture", services: ["workflow-builder"] }),
      ),
    ).resolves.toMatchObject({ status: "ok", httpStatus: 200 });
    expect(notAdmin.capture.captureAcceptanceCandidate).toHaveBeenCalled();

    await expect(
      notAdmin.service.continue(
        input({ action: "promote", artifactId: "artifact-1", draft: true }),
      ),
    ).resolves.toMatchObject({ status: "error", httpStatus: 403 });
    expect(notAdmin.promotion.promote).not.toHaveBeenCalled();
  });

  it("rejects acceptance without a server-stored promotion receipt", async () => {
    const artifact = {
      id: "source-artifact-promotion",
      workflowExecutionId: "execution-1",
      kind: "source-bundle",
      fileId: "file-1",
      inlinePayload: {
        tier: "tar-overlay-set",
        captureProtocol: "atomic-generation-v2",
        acceptanceEligible: true,
      },
      createdAt: new Date("2026-07-14T11:00:00.000Z"),
      metadata: {},
    };
    const h = harness({
      workflowData: {
        getScopedExecutionById: vi.fn(async () => ({ id: "execution-1" })),
        isPlatformAdmin: vi.fn(async () => true),
        getWorkflowArtifactForExecution: vi.fn(async () => artifact),
        listWorkflowArtifactsByExecutionId: vi.fn(async () => [artifact]),
        mergeWorkflowArtifactMetadata: vi.fn(async () => null),
      },
    });
    await expect(
      h.service.continue(
        input({ action: "acceptance", artifactId: "source-artifact-promotion" }),
      ),
    ).resolves.toMatchObject({ status: "error", httpStatus: 409 });
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });
});
