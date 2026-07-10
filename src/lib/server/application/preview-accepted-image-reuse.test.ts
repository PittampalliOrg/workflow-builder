import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewAcceptedImageReuseService } from "$lib/server/application/preview-accepted-image-reuse";
import { preparePreviewAcceptedImageReceipt } from "$lib/server/application/preview-accepted-images";
import type { PreviewAcceptedImageReceipt } from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const MERGE_SHA = "c".repeat(40);
const TREE_SHA = "d".repeat(40);
const CATALOG_DIGEST = `sha256:${"e".repeat(64)}` as const;
const IMAGE_DIGEST = `sha256:${"f".repeat(64)}` as const;

function receipt(): PreviewAcceptedImageReceipt {
  const content = preparePreviewAcceptedImageReceipt({
    repository: "PittampalliOrg/workflow-builder",
    pullRequestNumber: 42,
    baseSha: BASE_SHA as never,
    headSha: HEAD_SHA as never,
    catalogDigest: CATALOG_DIGEST,
    context: "preview/immutable-acceptance",
    subjects: [
      {
        subject: "workflow-builder",
        sourceRevision: HEAD_SHA as never,
        buildRun: "preview-accept-workflow-builder",
        imageRef: `ghcr.io/pittampalliorg/workflow-builder:git-${HEAD_SHA}`,
        digest: IMAGE_DIGEST,
        immutableRef: `ghcr.io/pittampalliorg/workflow-builder@${IMAGE_DIGEST}`,
      },
    ],
  });
  return {
    ...content,
    attestation: `v1.${"2".repeat(64)}`,
    createdAt: "2026-07-10T12:00:00.000Z",
  };
}

function harness() {
  const merges = {
    inspect: vi.fn(async () => ({
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA as never,
      headSha: HEAD_SHA as never,
      mergeSha: MERGE_SHA as never,
      baseRef: "main",
      headTreeSha: TREE_SHA as never,
      mergeTreeSha: TREE_SHA as never,
      changedPaths: ["src/routes/feature.ts"],
    })),
  };
  const receipts = {
    put: vi.fn(),
    getByRepoPrHeadContext: vi.fn(
      async (): Promise<PreviewAcceptedImageReceipt | null> => receipt(),
    ),
  };
  const catalog = {
    currentDigest: vi.fn(() => CATALOG_DIGEST),
    deriveChangedServices: vi.fn(() => ({
      services: ["workflow-builder"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    })),
  };
  const attestations = {
    attest: vi.fn(() => `v1.${"2".repeat(64)}` as const),
    verify: vi.fn(() => true),
  };
  return {
    merges,
    receipts,
    catalog,
    attestations,
    service: new ApplicationPreviewAcceptedImageReuseService({
      merges,
      receipts,
      attestations,
      catalog,
      sourceRepository: "PittampalliOrg/workflow-builder",
    }),
  };
}

const request = {
  repository: "PittampalliOrg/workflow-builder",
  mergeSha: MERGE_SHA as never,
  context: "preview/immutable-acceptance" as const,
  subject: "workflow-builder",
};

describe("ApplicationPreviewAcceptedImageReuseService", () => {
  it("reuses the exact receipt only for equivalent merged content and paths", async () => {
    const h = harness();
    await expect(h.service.resolve(request)).resolves.toEqual({
      ok: true,
      disposition: "reuse",
      mergeSha: MERGE_SHA,
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      receiptDigest: receipt().receiptDigest,
      image: receipt().subjects[0],
    });
    expect(h.receipts.getByRepoPrHeadContext).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      pullRequestNumber: 42,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      context: "preview/immutable-acceptance",
    });
  });

  it("falls back to a build for merge-tree, catalog, path, or receipt drift", async () => {
    const tree = harness();
    tree.merges.inspect.mockResolvedValueOnce({
      ...(await tree.merges.inspect()),
      mergeTreeSha: "2".repeat(40) as never,
    });
    await expect(tree.service.resolve(request)).resolves.toMatchObject({
      disposition: "build",
      reason: "content-drift",
    });

    const missing = harness();
    missing.receipts.getByRepoPrHeadContext.mockResolvedValueOnce(null);
    await expect(missing.service.resolve(request)).resolves.toMatchObject({
      reason: "receipt-absent",
    });

    const catalog = harness();
    catalog.catalog.currentDigest.mockReturnValueOnce(
      `sha256:${"3".repeat(64)}`,
    );
    await expect(catalog.service.resolve(request)).resolves.toMatchObject({
      reason: "catalog-drift",
    });

    const paths = harness();
    paths.catalog.deriveChangedServices.mockReturnValueOnce({
      services: ["workflow-builder", "workflow-orchestrator"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
    await expect(paths.service.resolve(request)).resolves.toMatchObject({
      reason: "subject-drift",
    });

    const untrusted = harness();
    untrusted.attestations.verify.mockReturnValueOnce(false);
    await expect(untrusted.service.resolve(request)).resolves.toMatchObject({
      disposition: "build",
      reason: "receipt-untrusted",
    });

    const forgedRow = harness();
    forgedRow.receipts.getByRepoPrHeadContext.mockRejectedValueOnce(
      new Error("accepted image receipt attestation is invalid"),
    );
    await expect(forgedRow.service.resolve(request)).resolves.toMatchObject({
      disposition: "build",
      reason: "receipt-untrusted",
    });
  });

  it("rejects requests outside the configured repository and exact merge SHA", async () => {
    const h = harness();
    await expect(
      h.service.resolve({ ...request, repository: "attacker/repo" }),
    ).rejects.toThrow("reuse request is invalid");
    await expect(
      h.service.resolve({ ...request, mergeSha: "main" as never }),
    ).rejects.toThrow("reuse request is invalid");
    expect(h.merges.inspect).not.toHaveBeenCalled();
  });
});
