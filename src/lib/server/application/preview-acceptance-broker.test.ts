import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewAcceptanceBrokerService } from "$lib/server/application/preview-acceptance-broker";
import { preparePreviewAcceptedImageReceipt } from "$lib/server/application/preview-accepted-images";
import { previewGateRequirementDigest } from "$lib/server/application/preview-gate-requirements";
import { resolvePreviewAcceptanceStatusReporting } from "$lib/server/application/adapters/preview-acceptance-status-reporting";
import type { PreviewGovernanceStatusMode } from "$lib/server/application/config";
import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptedImageReceiptStorePort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlPullRequestInspectionPort,
  PreviewControlSourceAuthorityPort,
} from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40);
const LIVE_BASE_SHA = "f".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;
const IMAGE_DIGEST = `sha256:${"e".repeat(64)}` as const;
const REQUIREMENT_DIGEST = previewGateRequirementDigest(
  CATALOG_DIGEST,
  "preview/immutable-acceptance",
  ["workflow-builder"],
);
const ACCEPTED_IMAGE = Object.freeze({
  service: "workflow-builder",
  sourceRevision: HEAD_SHA as never,
  buildId: "build-1",
  imageRef: `ghcr.io/pittampalliorg/workflow-builder:git-${HEAD_SHA}`,
  digest: IMAGE_DIGEST,
  immutableRef: `ghcr.io/pittampalliorg/workflow-builder@${IMAGE_DIGEST}`,
});
const ACCEPTED_RECEIPT = Object.freeze({
  ...preparePreviewAcceptedImageReceipt({
    repository: "PittampalliOrg/workflow-builder",
    pullRequestNumber: 42,
    baseSha: BASE_SHA as never,
    headSha: HEAD_SHA as never,
    catalogDigest: CATALOG_DIGEST,
    context: "preview/immutable-acceptance",
    subjects: [
      {
        subject: ACCEPTED_IMAGE.service,
        sourceRevision: ACCEPTED_IMAGE.sourceRevision,
        buildRun: ACCEPTED_IMAGE.buildId,
        imageRef: ACCEPTED_IMAGE.imageRef,
        digest: ACCEPTED_IMAGE.digest,
        immutableRef: ACCEPTED_IMAGE.immutableRef,
      },
    ],
  }),
  attestation: `v1.${"f".repeat(64)}` as const,
  createdAt: "2026-07-09T21:00:00.000Z",
});

function harness(
  options: Readonly<{ statusMode?: PreviewGovernanceStatusMode }> = {},
) {
  const pullRequests: PreviewControlPullRequestInspectionPort = {
    inspectOpen: vi.fn(),
    inspect: vi.fn(async (input) => ({
      ...input,
      headRef: "feature/preview-change",
      changedPaths: ["src/routes/new-feature.ts", "docs/preview.md"],
    })),
  };
  const catalog: PreviewAcceptanceChangedServiceCatalogPort = {
    currentDigest: () => CATALOG_DIGEST,
    deriveChangedServices: vi.fn(() => ({
      services: ["workflow-builder"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    })),
  };
  const authority: PreviewControlSourceAuthorityPort = {
    authorize: vi.fn(async (input) => ({
      previewName: input.previewName,
      requestId: input.environmentRequestId,
      owner: "admin-1",
      platformRevision: "d".repeat(40) as never,
      sourceRevision: BASE_SHA as never,
      catalogDigest: CATALOG_DIGEST,
      services: input.requiredServices,
    })),
    authorizeRuntime: vi.fn(),
    authorizeRuntimeTuple: vi.fn(),
    authorizeReadTuple: vi.fn(),
    authorizeCurrent: vi.fn(async (input) => ({
      previewName: input.previewName,
      requestId: "launch-1",
      owner: "admin-1",
      platformRevision: "d".repeat(40) as never,
      sourceRevision: BASE_SHA as never,
      catalogDigest: CATALOG_DIGEST,
      services: input.requiredServices,
    })),
  };
  const git: PreviewControlGitSourceVerificationPort = {
    verifyBranch: vi.fn(async () => true),
  };
  const acceptance = {
    replay: vi.fn(async () => ({
      ok: true as const,
      environment: { name: `accept-pr42-${HEAD_SHA.slice(0, 12)}` } as never,
      images: [ACCEPTED_IMAGE],
      verification: { ok: true, checks: [] },
      retained: false,
      cleanup: { complete: true } as never,
    })),
  };
  const statuses = {
    publish: vi.fn(async () => undefined),
    latest: vi.fn(),
  };
  const receipts: PreviewAcceptedImageReceiptStorePort = {
    put: vi.fn(async (receiptInput) =>
      Object.freeze({
        ...preparePreviewAcceptedImageReceipt(receiptInput),
        attestation: ACCEPTED_RECEIPT.attestation,
        createdAt: ACCEPTED_RECEIPT.createdAt,
      }),
    ),
    getByRepoPrHeadContext: vi.fn(async () => null),
  };
  const receiptAttestations = {
    attest: vi.fn(() => ACCEPTED_RECEIPT.attestation),
    verify: vi.fn(() => true),
  };
  const gate = { reconcile: vi.fn(async () => undefined) };
  const strictReporting = vi.fn(() => ({ statuses, gate }));
  const reporting = resolvePreviewAcceptanceStatusReporting(
    options.statusMode ?? "strict",
    strictReporting,
  );
  return {
    pullRequests,
    catalog,
    authority,
    git,
    acceptance,
    statuses,
    receipts,
    receiptAttestations,
    gate,
    strictReporting,
    service: new ApplicationPreviewAcceptanceBrokerService({
      pullRequests,
      catalog,
      authority,
      git,
      acceptance,
      statuses: reporting.statuses,
      receipts,
      receiptAttestations,
      gate: reporting.gate,
      sourceRepository: "PittampalliOrg/workflow-builder",
      baseBranch: "main",
      now: () => new Date("2026-07-09T21:00:00.000Z"),
    }),
  };
}

const input = {
  requestId: "request-1",
  previewName: "feature-one",
  environmentRequestId: "launch-1",
  environmentPlatformRevision: "d".repeat(40) as never,
  environmentSourceRevision: BASE_SHA as never,
  catalogDigest: CATALOG_DIGEST,
  pullRequest: {
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    baseSha: BASE_SHA as never,
    headSha: HEAD_SHA as never,
  },
};

describe("ApplicationPreviewAcceptanceBrokerService", () => {
  it("derives services and all replay authority from GitHub and physical preview state", async () => {
    const h = harness();
    await expect(h.service.replay(input)).resolves.toMatchObject({
      ok: true,
      name: `accept-pr42-${HEAD_SHA.slice(0, 12)}`,
      services: ["workflow-builder"],
    });
    expect(h.pullRequests.inspect).toHaveBeenCalledWith(input.pullRequest);
    expect(h.authority.authorize).toHaveBeenCalledWith({
      previewName: "feature-one",
      environmentRequestId: "launch-1",
      environmentPlatformRevision: "d".repeat(40),
      environmentSourceRevision: BASE_SHA,
      catalogDigest: CATALOG_DIGEST,
      requiredServices: ["workflow-builder"],
    });
    expect(h.git.verifyBranch).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      branch: "feature/preview-change",
      commitSha: HEAD_SHA,
      baseBranch: "main",
      baseRevision: BASE_SHA,
      expectedBaseSnapshot: BASE_SHA,
      expectedChangedPaths: [
        "src/routes/new-feature.ts",
        "docs/preview.md",
      ],
    });
    expect(h.acceptance.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        platformRevision: "d".repeat(40),
        sourceRevision: HEAD_SHA,
        owner: { kind: "user", id: "admin-1" },
        lifecycle: "ephemeral",
      }),
    );
    expect(h.statuses.publish).toHaveBeenNthCalledWith(1, {
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      context: "preview/immutable-acceptance",
      state: "pending",
      description: "Building immutable images for 1 service",
      requirementDigest: REQUIREMENT_DIGEST,
    });
    expect(h.statuses.publish).toHaveBeenNthCalledWith(2, {
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      context: "preview/immutable-acceptance",
      state: "success",
      description: "Immutable preview acceptance passed for 1 service",
      requirementDigest: REQUIREMENT_DIGEST,
      evidenceReceiptDigest: ACCEPTED_RECEIPT.receiptDigest,
    });
    expect(h.receipts.put).toHaveBeenCalledWith(
      expect.objectContaining({
        catalogDigest: CATALOG_DIGEST,
        context: "preview/immutable-acceptance",
        subjects: [expect.objectContaining({ subject: "workflow-builder" })],
      }),
    );
    expect(h.gate.reconcile).toHaveBeenCalledTimes(2);
    expect(h.gate.reconcile).toHaveBeenLastCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
  });

  it("fails before a build when the pending PR-head status cannot be published", async () => {
    const h = harness();
    vi.mocked(h.statuses.publish).mockRejectedValueOnce(
      new Error("status denied"),
    );
    await expect(h.service.replay(input)).rejects.toThrow("status denied");
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });

  it("reports a replay exception as an error on the exact PR head", async () => {
    const h = harness();
    vi.mocked(h.acceptance.replay).mockRejectedValueOnce(
      new Error("build transport failed"),
    );
    await expect(h.service.replay(input)).rejects.toThrow(
      "build transport failed",
    );
    expect(h.statuses.publish).toHaveBeenNthCalledWith(2, {
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      context: "preview/immutable-acceptance",
      state: "error",
      description: "Immutable preview acceptance could not complete",
      requirementDigest: REQUIREMENT_DIGEST,
    });
    expect(h.gate.reconcile).toHaveBeenCalledTimes(2);
  });

  it("fails closed in strict mode when the final acceptance result cannot become a pre-merge status", async () => {
    const h = harness();
    vi.mocked(h.statuses.publish)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status denied"));
    await expect(h.service.replay(input)).resolves.toMatchObject({
      ok: false,
      stage: "reporting",
      message: expect.stringContaining("status denied"),
    });
  });

  it("keeps a successful POC replay successful when strict status reporting is unavailable", async () => {
    const h = harness({ statusMode: "poc" });
    vi.mocked(h.statuses.publish).mockRejectedValue(new Error("status denied"));
    vi.mocked(h.gate.reconcile).mockRejectedValue(
      new Error("gate unavailable"),
    );

    await expect(h.service.replay(input)).resolves.toMatchObject({
      ok: true,
      evidenceReceiptDigest: ACCEPTED_RECEIPT.receiptDigest,
    });
    expect(h.strictReporting).not.toHaveBeenCalled();
    expect(h.statuses.publish).not.toHaveBeenCalled();
    expect(h.gate.reconcile).not.toHaveBeenCalled();
  });

  it("republishes a durable receipt without rebuilding after a reporting failure", async () => {
    const h = harness();
    vi.mocked(h.receipts.getByRepoPrHeadContext)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ACCEPTED_RECEIPT);
    vi.mocked(h.statuses.publish)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status denied"))
      .mockResolvedValueOnce(undefined);

    await expect(h.service.replay(input)).resolves.toMatchObject({
      ok: false,
      stage: "reporting",
    });
    await expect(h.service.replay(input)).resolves.toMatchObject({
      ok: true,
      evidenceReceiptDigest: ACCEPTED_RECEIPT.receiptDigest,
    });

    expect(h.acceptance.replay).toHaveBeenCalledOnce();
    expect(h.receipts.put).toHaveBeenCalledOnce();
    expect(h.statuses.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "preview/immutable-acceptance",
        state: "success",
        requirementDigest: REQUIREMENT_DIGEST,
        evidenceReceiptDigest: ACCEPTED_RECEIPT.receiptDigest,
      }),
    );
  });

  it("never converts an unattested database row into a signed success", async () => {
    const h = harness();
    vi.mocked(h.receipts.getByRepoPrHeadContext).mockResolvedValueOnce(
      ACCEPTED_RECEIPT,
    );
    h.receiptAttestations.verify.mockReturnValueOnce(false);

    await expect(h.service.replay(input)).rejects.toThrow(
      "does not match gate requirements",
    );
    expect(h.acceptance.replay).not.toHaveBeenCalled();
    expect(h.statuses.publish).not.toHaveBeenCalled();
  });

  it("rejects a synchronized PR before publishing or replaying against a stale head", async () => {
    const h = harness();
    vi.mocked(h.pullRequests.inspect)
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: BASE_SHA as never,
        headRef: "feature/preview-change",
        headSha: HEAD_SHA as never,
        changedPaths: ["src/routes/new-feature.ts"],
      })
      .mockRejectedValueOnce(
        new Error("GitHub pull request repo/base/head identity does not match"),
      );

    await expect(h.service.replay(input)).rejects.toThrow(
      "identity does not match",
    );
    expect(h.statuses.publish).not.toHaveBeenCalled();
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });

  it("rejects a physical authority response with any mismatched tuple field", async () => {
    const h = harness();
    vi.mocked(h.authority.authorize).mockResolvedValueOnce({
      previewName: "other-preview",
      requestId: "launch-1",
      owner: "admin-1",
      platformRevision: "d".repeat(40) as never,
      sourceRevision: BASE_SHA as never,
      catalogDigest: CATALOG_DIGEST,
      services: ["workflow-builder"],
    });
    await expect(h.service.replay(input)).rejects.toThrow(
      "different preview identity",
    );
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });

  it("fails closed on unmapped runtime files before source authority or builds", async () => {
    const h = harness();
    vi.mocked(h.catalog.deriveChangedServices).mockReturnValueOnce({
      services: [],
      activationArtifacts: [],
      unmappedRuntimePaths: ["services/unknown/src/index.ts"],
    });
    await expect(h.service.replay(input)).rejects.toThrow(
      "unmapped runtime paths",
    );
    expect(h.authority.authorize).not.toHaveBeenCalled();
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });

  it("accepts an advanced live base when the checkpoint branch still descends from the preview baseline", async () => {
    const h = harness();
    await expect(
      h.service.replay({
        ...input,
        pullRequest: { ...input.pullRequest, baseSha: LIVE_BASE_SHA as never },
      }),
    ).resolves.toMatchObject({
      ok: true,
      pullRequest: { baseSha: LIVE_BASE_SHA, headSha: HEAD_SHA },
    });
    expect(h.git.verifyBranch).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: BASE_SHA }),
    );
  });

  it("rejects an advanced live base when Git ancestry verification fails", async () => {
    const h = harness();
    vi.mocked(h.git.verifyBranch).mockResolvedValueOnce(false);

    await expect(
      h.service.replay({
        ...input,
        pullRequest: { ...input.pullRequest, baseSha: LIVE_BASE_SHA as never },
      }),
    ).rejects.toThrow("does not descend");
    expect(h.acceptance.replay).not.toHaveBeenCalled();
    expect(h.statuses.publish).not.toHaveBeenCalled();
  });
});
