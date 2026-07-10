import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewDevelopmentBuildBrokerService } from "$lib/server/application/preview-development-build-broker";
import type {
  PreviewAcceptanceChangedServiceCatalogPort,
  PreviewAcceptancePromotionPreparationPort,
  PreviewControlGitSourceVerificationPort,
  PreviewControlSourceAuthorityPort,
  PreviewEnvironmentDevelopmentImageBuildPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
  PreviewImportedArtifactIdentity,
  SourceBundlePromotionRunnerPort,
} from "$lib/server/application/ports";

const CANDIDATE_SHA = "a".repeat(40);
const BASELINE_PLATFORM_SHA = "b".repeat(40);
const BASELINE_SOURCE_SHA = "c".repeat(40);
const CATALOG_DIGEST = `sha256:${"d".repeat(64)}` as const;
const FILE_DIGEST = `sha256:${"f".repeat(64)}` as const;

function importedIdentity(
  services: readonly string[] = ["function-router", "workflow-builder"],
): PreviewImportedArtifactIdentity {
  return {
    previewName: "preview1",
    requestId: "launch-1",
    executionId: "exec-1",
    sourceArtifactId: "source-artifact-1",
    platformRevision: BASELINE_PLATFORM_SHA,
    sourceRevision: BASELINE_SOURCE_SHA,
    catalogDigest: CATALOG_DIGEST,
    services: [...services].sort(),
    captureId: "capture-1",
    generation: "generation-1",
    fileDigest: FILE_DIGEST,
  };
}

function harness() {
  const authority: PreviewControlSourceAuthorityPort = {
    authorize: vi.fn(async (request) => ({
      previewName: request.previewName,
      requestId: request.environmentRequestId,
      owner: "admin-1",
      platformRevision: request.environmentPlatformRevision as never,
      sourceRevision: request.environmentSourceRevision as never,
      catalogDigest: request.catalogDigest,
      services: [...request.requiredServices],
    })),
    authorizeRuntime: vi.fn(),
    authorizeCurrent: vi.fn(),
  };
  const git: PreviewControlGitSourceVerificationPort = {
    verifyBranch: vi.fn(async () => true),
  };
  const trust: PreviewAcceptancePromotionPreparationPort = {
    preparePromotion: vi.fn(async (request) => ({
      artifactId: request.artifact.artifactId,
      artifactIdentity: request.artifact.identity,
      fileId: "file-1",
      fileDigest: request.artifact.identity.fileDigest,
      services: request.artifact.identity.services,
      catalogDigest: request.artifact.identity.catalogDigest,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: request.artifact.identity.sourceRevision,
      platformRevision: request.artifact.identity.platformRevision,
    })),
  };
  const promotions: SourceBundlePromotionRunnerPort = {
    promoteSourceBundle: vi.fn(async () => ({
      status: "ok" as const,
      output: "",
      prUrl: null,
      branch: "preview-development-1720550000",
      commitSha: CANDIDATE_SHA,
      baseRevision: BASELINE_SOURCE_SHA,
      pullRequestBase: "main",
      changedPaths: ["services/function-router/src/index.ts"],
      prError: null,
    })),
  };
  const images: PreviewEnvironmentDevelopmentImageBuildPort = {
    build: vi.fn(async (request) => ({
      service: request.service,
      sourceRevision: request.sourceRevision,
      buildId: `build-${request.service}`,
      imageRef: `ghcr.io/pittampalliorg/${request.service}-dev:git-${request.sourceRevision}`,
      digest: `sha256:${"e".repeat(64)}` as const,
      immutableRef: `ghcr.io/pittampalliorg/${request.service}-dev@sha256:${"e".repeat(64)}`,
    })),
  };
  const catalog: PreviewEnvironmentVersionedServiceCatalogPort &
    PreviewAcceptanceChangedServiceCatalogPort = {
    currentDigest: () => CATALOG_DIGEST,
    listPreviewNativeServices: () => [
      "function-router",
      "workflow-builder",
      "workflow-orchestrator",
    ],
    assertPreviewNativeServices: (services) => {
      if (services.length === 0) throw new Error("no services");
      return [...services].sort();
    },
    deriveChangedServices: vi.fn((paths) => {
      if (
        paths.some((path: string) =>
          path.startsWith("services/shared/workflow-data-contract/"),
        )
      ) {
        return {
          services: ["workflow-builder", "workflow-orchestrator"],
          activationArtifacts: [],
          unmappedRuntimePaths: [],
        };
      }
      if (
        paths.some((path: string) =>
          path.startsWith("services/function-router/"),
        )
      ) {
        return {
          services: ["function-router"],
          activationArtifacts: [],
          unmappedRuntimePaths: [],
        };
      }
      return {
        services: [],
        activationArtifacts: [],
        unmappedRuntimePaths: [...paths],
      };
    }),
  };
  return {
    authority,
    git,
    images,
    trust,
    promotions,
    catalog,
    service: new ApplicationPreviewDevelopmentBuildBrokerService({
      authority,
      trust,
      promotions,
      git,
      images,
      catalog,
      sourceRepository: "PittampalliOrg/workflow-builder",
      baseBranch: "main",
    }),
  };
}

function input(services = ["workflow-builder", "function-router"]) {
  const identity = importedIdentity(services);
  return {
    requestId: "audit-request-1",
    executionId: identity.executionId,
    artifactId: "central-artifact-1",
    artifactIdentity: identity,
    previewName: identity.previewName,
    environmentRequestId: identity.requestId,
    environmentPlatformRevision: identity.platformRevision,
    environmentSourceRevision: identity.sourceRevision,
    catalogDigest: identity.catalogDigest,
    services,
  };
}

describe("ApplicationPreviewDevelopmentBuildBrokerService", () => {
  it("materializes on the captured SHA and builds only the changed selected service", async () => {
    const h = harness();
    const request = input();
    await expect(h.service.build(request)).resolves.toMatchObject({
      ok: true,
      previewName: "preview1",
      sourceRevision: CANDIDATE_SHA,
      baselineRevision: BASELINE_SOURCE_SHA,
      pullRequestBase: "main",
      changedPaths: ["services/function-router/src/index.ts"],
      services: [{ service: "function-router", ok: true }],
    });
    expect(h.git.verifyBranch).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      branch: "preview-development-1720550000",
      commitSha: CANDIDATE_SHA,
      baseBranch: "main",
      baseRevision: BASELINE_SOURCE_SHA,
    });
    expect(h.trust.preparePromotion).toHaveBeenCalledWith({
      artifact: {
        artifactId: "central-artifact-1",
        identity: request.artifactIdentity,
      },
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledWith({
      executionId: "exec-1",
      fileId: "file-1",
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      baseRevision: BASELINE_SOURCE_SHA,
      mode: "branch",
      title: "Preview development build (function-router, workflow-builder)",
      tier: "tar-overlay-set",
      repoSubdir: "",
      syncPaths: [],
      branchPrefix: "preview-development",
    });
    expect(h.images.build).toHaveBeenCalledOnce();
    expect(h.images.build).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: `preview-development:preview1:${CANDIDATE_SHA}:function-router`,
        service: "function-router",
      }),
    );
  });

  it("expands a shared workflow-data contract change to both affected services", async () => {
    const h = harness();
    vi.mocked(h.promotions.promoteSourceBundle).mockResolvedValueOnce({
      status: "ok",
      output: "",
      prUrl: null,
      branch: "preview-development-1720550000",
      commitSha: CANDIDATE_SHA,
      baseRevision: BASELINE_SOURCE_SHA,
      pullRequestBase: "main",
      changedPaths: ["services/shared/workflow-data-contract/schema.json"],
      prError: null,
    });
    const request = input(["workflow-builder", "workflow-orchestrator"]);

    await expect(h.service.build(request)).resolves.toMatchObject({
      services: [
        { service: "workflow-builder", ok: true },
        { service: "workflow-orchestrator", ok: true },
      ],
    });
    expect(h.images.build).toHaveBeenCalledTimes(2);
  });

  it("fails when the changed-service closure lacks a captured overlay", async () => {
    const h = harness();
    vi.mocked(h.promotions.promoteSourceBundle).mockResolvedValueOnce({
      status: "ok",
      output: "",
      prUrl: null,
      branch: "preview-development-1720550000",
      commitSha: CANDIDATE_SHA,
      baseRevision: BASELINE_SOURCE_SHA,
      pullRequestBase: "main",
      changedPaths: ["services/shared/workflow-data-contract/schema.json"],
      prError: null,
    });

    await expect(h.service.build(input(["workflow-builder"]))).rejects.toThrow(
      "without captured overlays: workflow-orchestrator",
    );
    expect(h.images.build).not.toHaveBeenCalled();
  });

  it("rejects cross-preview artifact identity reuse before authority or materialization", async () => {
    const h = harness();
    const request = input();
    await expect(
      h.service.build({
        ...request,
        artifactIdentity: {
          ...request.artifactIdentity,
          previewName: "preview2",
        },
      }),
    ).rejects.toThrow("does not match the broker request");
    expect(h.authority.authorize).not.toHaveBeenCalled();
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("rejects a trust adapter response that changes any imported identity field", async () => {
    const h = harness();
    vi.mocked(h.trust.preparePromotion).mockImplementationOnce(
      async (request) => ({
        artifactId: request.artifact.artifactId,
        artifactIdentity: {
          ...request.artifact.identity,
          generation: "tampered-generation",
        },
        fileId: "file-1",
        fileDigest: request.artifact.identity.fileDigest,
        services: request.artifact.identity.services,
        catalogDigest: request.artifact.identity.catalogDigest,
        repo: "PittampalliOrg/workflow-builder",
        base: "main",
        capturedSourceRevision: request.artifact.identity.sourceRevision,
        platformRevision: request.artifact.identity.platformRevision,
      }),
    );

    await expect(h.service.build(input())).rejects.toThrow(
      "does not match the authorized physical preview",
    );
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("deduplicates audit ids onto the exact affected-service operation key", async () => {
    const h = harness();
    await h.service.build(input());
    await h.service.build({ ...input(), requestId: "audit-request-2" });
    const operationIds = vi
      .mocked(h.images.build)
      .mock.calls.map(([request]) => request.requestId);
    expect(new Set(operationIds)).toEqual(
      new Set([
        `preview-development:preview1:${CANDIDATE_SHA}:function-router`,
      ]),
    );
  });

  it("does not build an unverified exact-baseline branch", async () => {
    const h = harness();
    vi.mocked(h.git.verifyBranch).mockResolvedValueOnce(false);
    await expect(h.service.build(input())).rejects.toThrow(
      "GitHub branch does not resolve",
    );
    expect(h.images.build).not.toHaveBeenCalled();
  });
});
