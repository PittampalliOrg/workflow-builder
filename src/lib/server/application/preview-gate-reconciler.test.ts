import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewGateReconcilerService } from "$lib/server/application/preview-gate-reconciler";
import { preparePreviewAcceptedImageReceipt } from "$lib/server/application/preview-accepted-images";
import { derivePreviewGateRequirementsFromSnapshot } from "$lib/server/application/preview-gate-requirements";
import type {
  PreviewAcceptanceCommitStatus,
  PreviewAcceptedImageReceipt,
  PreviewGateCatalogSnapshot,
  PreviewGateSubordinateContext,
} from "$lib/server/application/ports";

const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;
const tuple = {
  repository: "PittampalliOrg/workflow-builder",
  number: 42,
  baseSha: BASE_SHA as never,
  headSha: HEAD_SHA as never,
};
const snapshot: PreviewGateCatalogSnapshot = Object.freeze({
  catalogDigest: CATALOG_DIGEST,
  pathPolicy: Object.freeze({
    ignoredPathPrefixes: Object.freeze(["docs"]),
    unsupportedPathPrefixes: Object.freeze([
      ".github/CODEOWNERS",
      ".github/actions",
      ".github/workflows",
      "scripts/governance",
    ]),
    unmatchedPathPolicy: "unsupported" as const,
  }),
  services: Object.freeze([
    Object.freeze({
      service: "workflow-builder",
      changedPaths: Object.freeze(["src"]),
      acceptanceBuild: true,
      acceptanceReplay: true,
      activationBuild: false,
    }),
    Object.freeze({
      service: "dev-sync-sidecar",
      changedPaths: Object.freeze(["services/dev-sync-sidecar"]),
      acceptanceBuild: false,
      acceptanceReplay: false,
      activationBuild: true,
    }),
  ]),
});

function changedPathsFor(contexts: readonly PreviewGateSubordinateContext[]) {
  const paths: string[] = [];
  if (contexts.includes("preview/immutable-acceptance"))
    paths.push("src/feature.ts");
  if (contexts.includes("preview/activation-images"))
    paths.push("services/dev-sync-sidecar/server.mjs");
  return paths.length > 0 ? paths : ["docs/preview.md"];
}

function acceptedReceipt(
  context: PreviewGateSubordinateContext,
  subject: string,
): PreviewAcceptedImageReceipt {
  const imageRepository = `ghcr.io/pittampalliorg/${subject}`;
  const digest =
    context === "preview/immutable-acceptance"
      ? (`sha256:${"d".repeat(64)}` as const)
      : (`sha256:${"e".repeat(64)}` as const);
  return Object.freeze({
    ...preparePreviewAcceptedImageReceipt({
      repository: tuple.repository,
      pullRequestNumber: tuple.number,
      baseSha: tuple.baseSha,
      headSha: tuple.headSha,
      catalogDigest: CATALOG_DIGEST,
      context,
      subjects: [
        {
          subject,
          sourceRevision: tuple.headSha,
          buildRun: `build-${subject}`,
          imageRef: `${imageRepository}:git-${HEAD_SHA}`,
          digest,
          immutableRef: `${imageRepository}@${digest}`,
        },
      ],
    }),
    attestation:
      `v1.${context === "preview/immutable-acceptance" ? "1".repeat(64) : "2".repeat(64)}` as const,
    createdAt: "2026-07-09T21:00:00.000Z",
  });
}

function harness(
  contexts: PreviewGateSubordinateContext[],
  observed: Record<
    PreviewGateSubordinateContext,
    PreviewAcceptanceCommitStatus | null
  >,
) {
  const changedPaths = changedPathsFor(contexts);
  const requirements = derivePreviewGateRequirementsFromSnapshot(
    snapshot,
    changedPaths,
  );
  const evidence: Record<
    PreviewGateSubordinateContext,
    PreviewAcceptedImageReceipt | null
  > = {
    "preview/immutable-acceptance": contexts.includes(
      "preview/immutable-acceptance",
    )
      ? acceptedReceipt("preview/immutable-acceptance", "workflow-builder")
      : null,
    "preview/activation-images": contexts.includes("preview/activation-images")
      ? acceptedReceipt("preview/activation-images", "dev-sync-sidecar")
      : null,
  };
  const pullRequests = {
    inspectOpen: vi.fn(),
    inspect: vi.fn(async () => ({
      ...tuple,
      headRef: "feature/preview",
      changedPaths,
    })),
  };
  const catalog = {
    currentDigest: vi.fn(() => CATALOG_DIGEST),
    deriveGateRequirements: vi.fn(() => requirements),
  };
  const baseCatalog = {
    loadAt: vi.fn(async () => snapshot),
  };
  const receipts = {
    put: vi.fn(),
    getByRepoPrHeadContext: vi.fn(
      async (input: { context: PreviewGateSubordinateContext }) =>
        evidence[input.context],
    ),
  };
  const receiptAttestations = {
    attest: vi.fn(() => `v1.${"1".repeat(64)}` as const),
    verify: vi.fn(() => true),
  };
  const statuses = {
    latest: vi.fn(async () => observed),
    publish: vi.fn(async () => undefined),
  };
  return {
    pullRequests,
    catalog,
    baseCatalog,
    receipts,
    receiptAttestations,
    statuses,
    service: new ApplicationPreviewGateReconcilerService({
      pullRequests,
      catalog,
      baseCatalog,
      receipts,
      receiptAttestations,
      statuses,
    }),
  };
}

describe("ApplicationPreviewGateReconcilerService", () => {
  it("keeps aggregate pending until every applicable subordinate succeeds", async () => {
    const h = harness(
      ["preview/immutable-acceptance", "preview/activation-images"],
      {
        "preview/immutable-acceptance": "success",
        "preview/activation-images": "pending",
      },
    );
    await h.service.reconcile(tuple);
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "preview/gate",
        state: "pending",
        description: "Preview evidence pending (1/2)",
      }),
    );
  });

  it("succeeds only when the complete requirement union succeeds", async () => {
    const h = harness(
      ["preview/immutable-acceptance", "preview/activation-images"],
      {
        "preview/immutable-acceptance": "success",
        "preview/activation-images": "success",
      },
    );
    await h.service.reconcile(tuple);
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({ context: "preview/gate", state: "success" }),
    );
    expect(h.pullRequests.inspect).toHaveBeenCalledTimes(2);
    expect(h.statuses.latest).toHaveBeenCalledWith(
      expect.objectContaining({
        requirementDigests: expect.objectContaining({
          "preview/immutable-acceptance": expect.stringMatching(/^sha256:/),
          "preview/activation-images": expect.stringMatching(/^sha256:/),
        }),
        evidenceReceiptDigests: expect.objectContaining({
          "preview/immutable-acceptance": expect.stringMatching(/^sha256:/),
          "preview/activation-images": expect.stringMatching(/^sha256:/),
        }),
      }),
    );
  });

  it("fails closed for unmapped runtime paths without trusting statuses", async () => {
    const h = harness([], {
      "preview/immutable-acceptance": null,
      "preview/activation-images": null,
    });
    const changedPaths = ["services/unknown/app.py"];
    const requirements = derivePreviewGateRequirementsFromSnapshot(
      snapshot,
      changedPaths,
    );
    h.pullRequests.inspect.mockResolvedValue({
      ...tuple,
      headRef: "feature/preview",
      changedPaths,
    });
    h.catalog.deriveGateRequirements.mockReturnValue(requirements);
    await h.service.reconcile(tuple);
    expect(h.statuses.latest).not.toHaveBeenCalled();
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({ context: "preview/gate", state: "failure" }),
    );
  });

  it("cannot overwrite initializer failure on a mixed runtime and governance PR", async () => {
    const h = harness(["preview/immutable-acceptance"], {
      "preview/immutable-acceptance": "success",
      "preview/activation-images": null,
    });
    const changedPaths = [
      "src/feature.ts",
      ".github/workflows/exfiltrate-app-key.yml",
    ];
    const requirements = derivePreviewGateRequirementsFromSnapshot(
      snapshot,
      changedPaths,
    );
    h.pullRequests.inspect.mockResolvedValue({
      ...tuple,
      headRef: "feature/preview",
      changedPaths,
    });
    h.catalog.deriveGateRequirements.mockReturnValue(requirements);

    await h.service.reconcile(tuple);
    expect(h.statuses.latest).not.toHaveBeenCalled();
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({ context: "preview/gate", state: "failure" }),
    );
  });

  it("rechecks the exact tuple before aggregate publication", async () => {
    const h = harness(["preview/immutable-acceptance"], {
      "preview/immutable-acceptance": "success",
      "preview/activation-images": null,
    });
    h.pullRequests.inspect
      .mockResolvedValueOnce({
        ...tuple,
        headRef: "feature/preview",
        changedPaths: ["src/feature.ts"],
      })
      .mockRejectedValueOnce(new Error("tuple changed"));
    await expect(h.service.reconcile(tuple)).rejects.toThrow("tuple changed");
    expect(h.statuses.publish).not.toHaveBeenCalled();
  });

  it("publishes error and refuses evidence when deployed catalog differs from the PR base", async () => {
    const h = harness(["preview/immutable-acceptance"], {
      "preview/immutable-acceptance": "success",
      "preview/activation-images": null,
    });
    h.baseCatalog.loadAt.mockResolvedValueOnce({
      ...snapshot,
      catalogDigest: `sha256:${"f".repeat(64)}`,
    });
    await expect(h.service.reconcile(tuple)).rejects.toThrow(
      /do(?:es)? not match the exact PR base catalog/,
    );
    expect(h.statuses.latest).not.toHaveBeenCalled();
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "preview/gate",
        state: "error",
      }),
    );
  });

  it("rejects a durable receipt whose content does not match its digest", async () => {
    const h = harness(["preview/immutable-acceptance"], {
      "preview/immutable-acceptance": "success",
      "preview/activation-images": null,
    });
    const receipt = await h.receipts.getByRepoPrHeadContext({
      context: "preview/immutable-acceptance",
    });
    h.receipts.getByRepoPrHeadContext.mockResolvedValueOnce({
      ...receipt!,
      receiptDigest: `sha256:${"0".repeat(64)}`,
    });
    await expect(h.service.reconcile(tuple)).rejects.toThrow(
      "accepted image receipt does not match gate requirements",
    );
    expect(h.statuses.latest).not.toHaveBeenCalled();
  });

  it("rejects a durable receipt without broker HMAC provenance", async () => {
    const h = harness(["preview/immutable-acceptance"], {
      "preview/immutable-acceptance": "success",
      "preview/activation-images": null,
    });
    h.receiptAttestations.verify.mockReturnValueOnce(false);

    await expect(h.service.reconcile(tuple)).rejects.toThrow(
      "accepted image receipt does not match gate requirements",
    );
    expect(h.statuses.latest).not.toHaveBeenCalled();
    expect(h.statuses.publish).toHaveBeenCalledWith(
      expect.objectContaining({ context: "preview/gate", state: "error" }),
    );
  });
});
