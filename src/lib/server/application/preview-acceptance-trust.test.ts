import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewAcceptanceTrustService } from "$lib/server/application/preview-acceptance-trust";
import {
  PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY,
  type PreviewAcceptanceArtifactPort,
  type PreviewAcceptanceArtifactSnapshot,
} from "$lib/server/application/ports";

const FILE_DIGEST = `sha256:${"d".repeat(64)}` as const;
const CATALOG_DIGEST = `sha256:${"e".repeat(64)}` as const;
const PLATFORM_REVISION = "a".repeat(40);
const SOURCE_REVISION = "b".repeat(40);

const artifactIdentity = {
  previewName: "preview-one",
  requestId: "launch-1",
  executionId: "exec-1",
  sourceArtifactId: "source-artifact-1",
  platformRevision: PLATFORM_REVISION,
  sourceRevision: SOURCE_REVISION,
  catalogDigest: CATALOG_DIGEST,
  services: ["function-router", "workflow-builder"],
  captureId: "capture-1",
  generation: "generation-1",
  fileDigest: FILE_DIGEST,
} as const;

function capture(
  overrides: Partial<PreviewAcceptanceArtifactSnapshot> = {},
): PreviewAcceptanceArtifactSnapshot {
  return {
    id: "central-artifact-1",
    executionId: "exec-1",
    kind: "source-bundle",
    fileId: "file-1",
    inlinePayload: {
      manifestVersion: 2,
      acceptanceEligible: true,
      captureProtocol: "atomic-generation-v2",
      captureId: "capture-1",
      generation: "generation-1",
      catalogDigest: CATALOG_DIGEST,
      services: ["function-router", "workflow-builder"],
      overlayDigests: {
        "function-router": `sha256:${"1".repeat(64)}`,
        "workflow-builder": `sha256:${"2".repeat(64)}`,
      },
      repoUrl: "PittampalliOrg/workflow-builder",
      base: "main",
      sourceRevision: SOURCE_REVISION,
      platformRevision: PLATFORM_REVISION,
    },
    metadata: null,
    importIdentity: artifactIdentity,
    ...overrides,
  };
}

function harness(
  artifact: PreviewAcceptanceArtifactSnapshot | null = capture(),
) {
  const artifacts: PreviewAcceptanceArtifactPort = {
    get: vi.fn(async () => artifact),
    fileDigest: vi.fn(async () => FILE_DIGEST),
  };
  return {
    artifacts,
    service: new ApplicationPreviewAcceptanceTrustService({
      artifacts,
      catalog: { currentDigest: () => CATALOG_DIGEST },
    }),
  };
}

const input = {
  artifact: {
    artifactId: "central-artifact-1",
    identity: artifactIdentity,
  },
  repo: "PittampalliOrg/workflow-builder",
  base: "main",
};

describe("ApplicationPreviewAcceptanceTrustService", () => {
  it("binds physical materialization to one strict central artifact and file digest", async () => {
    const h = harness();
    await expect(h.service.preparePromotion(input)).resolves.toEqual({
      artifactId: "central-artifact-1",
      artifactIdentity,
      fileId: "file-1",
      fileDigest: FILE_DIGEST,
      services: ["function-router", "workflow-builder"],
      catalogDigest: CATALOG_DIGEST,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: SOURCE_REVISION,
      platformRevision: PLATFORM_REVISION,
    });
    expect(h.artifacts.fileDigest).toHaveBeenCalledWith({
      ...input.artifact,
      fileId: "file-1",
    });
  });

  it("rejects repository, catalog, file, and legacy-attestation mismatches", async () => {
    await expect(
      harness().service.preparePromotion({ ...input, repo: "attacker/repo" }),
    ).rejects.toMatchObject({ code: "repository-mismatch" });

    const stale = capture({
      inlinePayload: {
        ...(capture().inlinePayload as Record<string, unknown>),
        catalogDigest: `sha256:${"9".repeat(64)}`,
      },
      importIdentity: {
        ...artifactIdentity,
        catalogDigest: `sha256:${"9".repeat(64)}`,
      },
    });
    await expect(
      harness(stale).service.preparePromotion({
        ...input,
        artifact: {
          ...input.artifact,
          identity: {
            ...artifactIdentity,
            catalogDigest: `sha256:${"9".repeat(64)}`,
          },
        },
      }),
    ).rejects.toMatchObject({ code: "catalog-mismatch" });

    const missingFile = harness();
    vi.mocked(missingFile.artifacts.fileDigest).mockResolvedValueOnce(null);
    await expect(
      missingFile.service.preparePromotion(input),
    ).rejects.toMatchObject({
      code: "file-not-found",
    });

    const legacy = capture({
      metadata: { [PREVIEW_ACCEPTANCE_ATTESTATION_METADATA_KEY]: "retired" },
    });
    await expect(
      harness(legacy).service.preparePromotion(input),
    ).rejects.toMatchObject({
      code: "already-attested",
    });
  });

  it("rejects cross-preview identity reuse before reading artifact bytes", async () => {
    const h = harness();
    await expect(
      h.service.preparePromotion({
        ...input,
        artifact: {
          ...input.artifact,
          identity: { ...artifactIdentity, previewName: "preview-two" },
        },
      }),
    ).rejects.toMatchObject({ code: "identity-mismatch" });
    expect(h.artifacts.fileDigest).not.toHaveBeenCalled();
  });
});
