import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewActivationGateService } from "$lib/server/application/preview-activation-gate";
import { preparePreviewAcceptedImageReceipt } from "$lib/server/application/preview-accepted-images";
import { previewGateRequirementDigest } from "$lib/server/application/preview-gate-requirements";
import type {
  ImmutableGitSha,
  PreviewAcceptanceChangedServices,
  PreviewAcceptedImageReceiptStorePort,
} from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40) as ImmutableGitSha;
const HEAD_SHA = "b".repeat(40) as ImmutableGitSha;
const DIGEST = `sha256:${"c".repeat(64)}` as const;
const REQUIREMENT_DIGEST = previewGateRequirementDigest(
  DIGEST,
  "preview/activation-images",
  ["dev-sync-sidecar"],
);
const tuple = {
  repository: "PittampalliOrg/workflow-builder",
  number: 42,
  baseSha: BASE_SHA,
  headSha: HEAD_SHA,
};

function harness() {
  const pullRequests = {
    inspectOpen: vi.fn(),
    inspect: vi.fn(async () => ({
      ...tuple,
      headRef: "feature/activation",
      changedPaths: ["services/dev-sync-sidecar/server.mjs"],
    })),
  };
  const catalog = {
    currentDigest: vi.fn(() => DIGEST),
    deriveChangedServices: vi.fn(
      (): PreviewAcceptanceChangedServices => ({
        services: [],
        activationArtifacts: ["dev-sync-sidecar"],
        unmappedRuntimePaths: [],
      }),
    ),
  };
  const image = {
    artifact: "dev-sync-sidecar" as const,
    sourceRevision: HEAD_SHA,
    pipelineRun: "activation-dev-sync-sidecar",
    imageRef: `ghcr.io/pittampalliorg/dev-sync-sidecar:git-${HEAD_SHA}`,
    digest: `sha256:${"d".repeat(64)}` as const,
    immutableRef: `ghcr.io/pittampalliorg/dev-sync-sidecar@sha256:${"d".repeat(64)}`,
  };
  const builds = { build: vi.fn(async () => image) };
  const receipt = Object.freeze({
    ...preparePreviewAcceptedImageReceipt({
      repository: tuple.repository,
      pullRequestNumber: tuple.number,
      baseSha: tuple.baseSha,
      headSha: tuple.headSha,
      catalogDigest: DIGEST,
      context: "preview/activation-images",
      subjects: [
        {
          subject: image.artifact,
          sourceRevision: image.sourceRevision,
          buildRun: image.pipelineRun,
          imageRef: image.imageRef,
          digest: image.digest,
          immutableRef: image.immutableRef,
        },
      ],
    }),
    attestation: `v1.${"e".repeat(64)}` as const,
    createdAt: "2026-07-09T21:00:00.000Z",
  });
  const receipts: PreviewAcceptedImageReceiptStorePort = {
    put: vi.fn(async () => receipt),
    getByRepoPrHeadContext: vi.fn(async () => null),
  };
  const receiptAttestations = {
    attest: vi.fn(() => receipt.attestation),
    verify: vi.fn(() => true),
  };
  const statuses = {
    latest: vi.fn(),
    publish: vi.fn(async () => undefined),
  };
  const gate = { reconcile: vi.fn(async () => undefined) };
  return {
    pullRequests,
    catalog,
    builds,
    receipt,
    receipts,
    receiptAttestations,
    statuses,
    gate,
    service: new ApplicationPreviewActivationGateService({
      pullRequests,
      catalog,
      builds,
      receipts,
      receiptAttestations,
      statuses,
      gate,
      sourceRepository: tuple.repository,
    }),
  };
}

const input = {
  requestId: "request-1",
  catalogDigest: DIGEST,
  pullRequest: tuple,
};

describe("ApplicationPreviewActivationGateService", () => {
  it("builds only catalog-derived artifacts and finalizes subordinate before aggregate", async () => {
    const h = harness();
    await expect(h.service.buildAndFinalize(input)).resolves.toMatchObject({
      ok: true,
      pullRequest: tuple,
      images: [{ artifact: "dev-sync-sidecar", sourceRevision: HEAD_SHA }],
    });
    expect(h.builds.build).toHaveBeenCalledWith({
      requestId: `activation:42:${HEAD_SHA.slice(0, 12)}:dev-sync-sidecar:request-1`,
      artifact: "dev-sync-sidecar",
      sourceRepository: tuple.repository,
      sourceRevision: HEAD_SHA,
      catalogDigest: DIGEST,
    });
    expect(h.statuses.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        context: "preview/activation-images",
        state: "pending",
        requirementDigest: REQUIREMENT_DIGEST,
      }),
    );
    expect(h.statuses.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        context: "preview/activation-images",
        state: "success",
        requirementDigest: REQUIREMENT_DIGEST,
        evidenceReceiptDigest: h.receipt.receiptDigest,
      }),
    );
    expect(h.receipts.put).toHaveBeenCalledOnce();
    expect(h.gate.reconcile).toHaveBeenCalledTimes(2);
    expect(h.pullRequests.inspect).toHaveBeenCalledTimes(3);
  });

  it("rejects a PR that has no activation requirement", async () => {
    const h = harness();
    h.catalog.deriveChangedServices.mockReturnValueOnce({
      services: ["workflow-builder"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
    await expect(h.service.buildAndFinalize(input)).rejects.toThrow(
      "does not require activation-image evidence",
    );
    expect(h.builds.build).not.toHaveBeenCalled();
    expect(h.statuses.publish).not.toHaveBeenCalled();
  });

  it("publishes terminal error and recomputes aggregate when the physical build fails", async () => {
    const h = harness();
    h.builds.build.mockRejectedValueOnce(new Error("PipelineRun failed"));
    await expect(h.service.buildAndFinalize(input)).rejects.toThrow(
      "PipelineRun failed",
    );
    expect(h.statuses.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "preview/activation-images",
        state: "error",
      }),
    );
    expect(h.gate.reconcile).toHaveBeenCalledTimes(2);
  });

  it("republishes a durable receipt without rebuilding after status delivery fails", async () => {
    const h = harness();
    vi.mocked(h.receipts.getByRepoPrHeadContext)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(h.receipt);
    h.statuses.publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("status denied"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    await expect(h.service.buildAndFinalize(input)).rejects.toThrow(
      "status denied",
    );
    await expect(h.service.buildAndFinalize(input)).resolves.toMatchObject({
      ok: true,
      evidenceReceiptDigest: h.receipt.receiptDigest,
    });
    expect(h.builds.build).toHaveBeenCalledOnce();
    expect(h.receipts.put).toHaveBeenCalledOnce();
    expect(h.statuses.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: "preview/activation-images",
        state: "success",
        requirementDigest: REQUIREMENT_DIGEST,
        evidenceReceiptDigest: h.receipt.receiptDigest,
      }),
    );
  });

  it("never converts an unattested database row into a signed success", async () => {
    const h = harness();
    vi.mocked(h.receipts.getByRepoPrHeadContext).mockResolvedValueOnce(
      h.receipt,
    );
    h.receiptAttestations.verify.mockReturnValueOnce(false);

    await expect(h.service.buildAndFinalize(input)).rejects.toThrow(
      "does not match gate requirements",
    );
    expect(h.builds.build).not.toHaveBeenCalled();
    expect(h.statuses.publish).not.toHaveBeenCalled();
  });

  it("cannot finalize an old head after the PR tuple changes", async () => {
    const h = harness();
    h.pullRequests.inspect
      .mockResolvedValueOnce({
        ...tuple,
        headRef: "feature/activation",
        changedPaths: ["services/dev-sync-sidecar/server.mjs"],
      })
      .mockResolvedValueOnce({
        ...tuple,
        headRef: "feature/activation",
        changedPaths: ["services/dev-sync-sidecar/server.mjs"],
      })
      .mockRejectedValueOnce(new Error("tuple changed"))
      .mockRejectedValueOnce(new Error("tuple changed"));
    await expect(h.service.buildAndFinalize(input)).rejects.toThrow(
      /tuple changed; exact-head reporting failed: tuple changed/,
    );
    expect(h.statuses.publish).toHaveBeenCalledTimes(1);
    expect(h.statuses.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "success" }),
    );
  });
});
