import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewSourcePromotionBrokerService,
  ApplicationPreviewSourcePromotionService,
} from "$lib/server/application/preview-source-promotion";
import { HttpPreviewSourcePromotionBrokerAdapter } from "$lib/server/application/adapters/preview-control";
import type {
  ImmutableGitSha,
  PreviewImportedArtifactIdentity,
  PreviewSourcePromotionBrokerRequest,
} from "$lib/server/application/ports";

const PLATFORM = "a".repeat(40) as ImmutableGitSha;
const SOURCE = "b".repeat(40) as ImmutableGitSha;
const COMMIT = "c".repeat(40) as ImmutableGitSha;
const CATALOG = `sha256:${"d".repeat(64)}` as const;
const FILE = `sha256:${"e".repeat(64)}` as const;
const BRANCH = "preview-feature-central-artifact-1";
const FIVE_CAPTURED_SERVICES = Object.freeze([
  "function-router",
  "mcp-gateway",
  "workflow-builder",
  "workflow-mcp-server",
  "workflow-orchestrator",
]);

const identity: PreviewImportedArtifactIdentity = {
  previewName: "preview-one",
  requestId: "request-1",
  executionId: "execution-1",
  sourceArtifactId: "source-artifact-1",
  platformRevision: PLATFORM,
  sourceRevision: SOURCE,
  catalogDigest: CATALOG,
  services: ["workflow-builder"],
  captureId: "capture-1",
  generation: "generation-1",
  fileDigest: FILE,
};

const command: PreviewSourcePromotionBrokerRequest = {
  operationId: "central-artifact-1",
  previewName: "preview-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: PLATFORM,
  environmentSourceRevision: SOURCE,
  catalogDigest: CATALOG,
  executionId: "execution-1",
  artifactId: "central-artifact-1",
  artifactIdentity: identity,
  title: "Feature change",
  bodyMarkdown: "Tested in preview-one.",
  draft: true,
};
const fiveServiceCommand: PreviewSourcePromotionBrokerRequest = {
  ...command,
  artifactIdentity: {
    ...identity,
    services: FIVE_CAPTURED_SERVICES,
  },
};

function promotionBrokerProof(services: readonly string[]) {
  return {
    ok: true,
    previewName: "preview-one",
    requestId: "request-1",
    executionId: "execution-1",
    artifactId: "central-artifact-1",
    services,
    branch: BRANCH,
    commitSha: COMMIT,
    prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
    pullRequest: {
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: SOURCE,
      headSha: COMMIT,
    },
    draft: true,
  };
}

function promotionHttpHarness(body: unknown) {
  const fetchImpl = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const adapter = new HttpPreviewSourcePromotionBrokerAdapter({
    baseUrl: () => "http://preview-control-broker:3000/",
    token: () => "leaf-token",
    identity: () => ({
      previewName: "preview-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: PLATFORM,
      environmentSourceRevision: SOURCE,
      catalogDigest: CATALOG,
    }),
    fetch: fetchImpl as typeof fetch,
  });
  return { adapter, fetchImpl };
}

function brokerHarness() {
  const authority = {
    authorize: vi.fn(async () => ({
      previewName: "preview-one",
      requestId: "request-1",
      owner: "admin-1",
      platformRevision: PLATFORM,
      sourceRevision: SOURCE,
      catalogDigest: CATALOG,
      services: ["workflow-builder"],
    })),
    authorizeRuntime: vi.fn(),
    authorizeCurrent: vi.fn(),
  };
  const trust = {
    preparePromotion: vi.fn(async () => ({
      artifactId: "central-artifact-1",
      artifactIdentity: identity,
      fileId: "file-1",
      fileDigest: FILE,
      services: ["workflow-builder"],
      catalogDigest: CATALOG,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: SOURCE,
      platformRevision: PLATFORM,
    })),
  };
  const promotions = {
    promoteSourceBundle: vi.fn(async () => ({
      status: "ok" as const,
      output: "",
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      branch: BRANCH,
      commitSha: COMMIT,
      baseRevision: SOURCE,
      pullRequestBase: "main",
      changedPaths: ["src/routes/feature.ts"],
      prError: null,
    })),
  };
  const git = { verifyBranch: vi.fn(async () => true) };
  const pullRequests = {
    inspectOpen: vi.fn(async () => ({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: SOURCE,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    })),
    inspect: vi.fn(),
  };
  const catalog = {
    currentDigest: () => CATALOG,
    listPreviewNativeServices: () => ["workflow-builder"],
    assertPreviewNativeServices: (services: readonly string[]) => {
      if (services.length === 0) throw new Error("services required");
      return [...services].sort();
    },
    deriveChangedServices: vi.fn(() => ({
      services: ["workflow-builder"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    })),
  };
  return {
    authority,
    trust,
    promotions,
    git,
    pullRequests,
    catalog,
    service: new ApplicationPreviewSourcePromotionBrokerService({
      authority: authority as never,
      trust,
      promotions,
      git,
      pullRequests,
      catalog,
      sourceRepository: "PittampalliOrg/workflow-builder",
      baseBranch: "main",
    }),
  };
}

describe("preview source promotion", () => {
  it("transfers the local artifact before invoking the physical broker", async () => {
    const artifacts = {
      transfer: vi.fn(async () => ({
        id: "central-artifact-1",
        fileId: "central-file-1",
        fileDigest: FILE,
        artifact: {} as never,
        importIdentity: identity,
      })),
    };
    const broker = {
      promote: vi.fn(async () => ({
        ok: true as const,
        previewName: "preview-one",
        requestId: "request-1",
        executionId: "execution-1",
        artifactId: "central-artifact-1",
        services: ["workflow-builder"],
        branch: BRANCH,
        commitSha: COMMIT,
        prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
        pullRequest: {
          repository: "PittampalliOrg/workflow-builder",
          number: 42,
          baseSha: SOURCE,
          headSha: COMMIT,
        },
        draft: true,
      })),
    };
    const service = new ApplicationPreviewSourcePromotionService({
      identity: {
        current: () => ({
          previewName: "preview-one",
          environmentRequestId: "request-1",
          environmentPlatformRevision: PLATFORM,
          environmentSourceRevision: SOURCE,
          catalogDigest: CATALOG,
        }),
      },
      artifacts,
      broker,
    });
    await service.promote({
      executionId: "execution-1",
      artifactId: "source-artifact-1",
      title: " Feature change ",
      bodyMarkdown: " Tested in preview-one. ",
      draft: true,
    });
    expect(artifacts.transfer).toHaveBeenCalledWith({
      identity: expect.objectContaining({ previewName: "preview-one" }),
      executionId: "execution-1",
      artifactId: "source-artifact-1",
    });
    expect(broker.promote).toHaveBeenCalledWith(command);
  });

  it("materializes and verifies a PR only after exact physical authorization", async () => {
    const h = brokerHarness();
    await expect(h.service.promote(command)).resolves.toMatchObject({
      ok: true,
      commitSha: COMMIT,
      services: ["workflow-builder"],
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: SOURCE,
        headSha: COMMIT,
      },
    });
    expect(h.authority.authorize).toHaveBeenCalledBefore(
      h.promotions.promoteSourceBundle,
    );
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: BRANCH,
        branchPrefix: "preview-feature",
      }),
    );
    expect(h.git.verifyBranch).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      branch: BRANCH,
      commitSha: COMMIT,
      baseBranch: "main",
      baseRevision: SOURCE,
      expectedChangedPaths: ["src/routes/feature.ts"],
    });
    expect(h.pullRequests.inspectOpen).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
    });
  });

  it("rejects an attacker-controlled artifact tuple before Git or GitHub", async () => {
    const h = brokerHarness();
    await expect(
      h.service.promote({
        ...command,
        artifactIdentity: { ...identity, previewName: "preview-other" },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(h.trust.preparePromotion).not.toHaveBeenCalled();
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("binds the idempotency key to the imported artifact before Git", async () => {
    const h = brokerHarness();
    await expect(
      h.service.promote({ ...command, operationId: "different-operation" }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(h.trust.preparePromotion).not.toHaveBeenCalled();
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("rejects a prepared file whose digest changed before Git or GitHub", async () => {
    const h = brokerHarness();
    h.trust.preparePromotion.mockResolvedValueOnce({
      artifactId: "central-artifact-1",
      artifactIdentity: identity,
      fileId: "file-1",
      fileDigest: `sha256:${"f".repeat(64)}`,
      services: ["workflow-builder"],
      catalogDigest: CATALOG,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: SOURCE,
      platformRevision: PLATFORM,
    });
    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "artifact-rejected",
    });
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
    expect(h.git.verifyBranch).not.toHaveBeenCalled();
  });

  it("rejects malformed PR proof returned by the physical runner", async () => {
    const h = brokerHarness();
    h.promotions.promoteSourceBundle.mockResolvedValueOnce({
      status: "ok",
      output: "",
      prUrl: "https://attacker.example/pull/42",
      branch: BRANCH,
      commitSha: COMMIT,
      baseRevision: SOURCE,
      pullRequestBase: "main",
      changedPaths: ["src/routes/feature.ts"],
      prError: null,
    });
    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "materialization-failed",
    });
    expect(h.git.verifyBranch).not.toHaveBeenCalled();
  });

  it("rejects a PR URL whose GitHub head is not the promoted branch", async () => {
    const h = brokerHarness();
    h.pullRequests.inspectOpen.mockResolvedValueOnce({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: SOURCE,
      headRef: "unrelated-branch",
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    });
    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "materialization-failed",
      statusCode: 409,
    });
    expect(h.git.verifyBranch).not.toHaveBeenCalled();
  });

  it("rejects a PR whose base advanced beyond the captured preview baseline", async () => {
    const h = brokerHarness();
    h.pullRequests.inspectOpen.mockResolvedValueOnce({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: "f".repeat(40) as ImmutableGitSha,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    });
    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "materialization-failed",
      statusCode: 409,
    });
    expect(h.git.verifyBranch).not.toHaveBeenCalled();
  });
});

describe("preview source promotion HTTP adapter", () => {
  it("sends the tuple capability to the fixed physical broker route", async () => {
    const { adapter, fetchImpl } = promotionHttpHarness(
      promotionBrokerProof(["workflow-builder"]),
    );
    await expect(adapter.promote(command)).resolves.toMatchObject({
      ok: true,
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: SOURCE,
        headSha: COMMIT,
      },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "http://preview-control-broker:3000/api/internal/preview-control/promotion",
    );
    expect(new Headers(init?.headers).get("x-preview-control-capability")).toBe(
      "leaf-token",
    );
    expect(JSON.parse(String(init?.body))).toEqual(command);
  });

  it("accepts a canonical changed-service subset of five captured services", async () => {
    const changedServices = ["workflow-builder", "workflow-orchestrator"];
    const { adapter } = promotionHttpHarness(
      promotionBrokerProof(changedServices),
    );

    await expect(adapter.promote(fiveServiceCommand)).resolves.toMatchObject({
      services: changedServices,
    });
  });

  it("rejects an extra service outside the captured artifact", async () => {
    const { adapter } = promotionHttpHarness(
      promotionBrokerProof(["unknown-service", "workflow-builder"]),
    );

    await expect(adapter.promote(fiveServiceCommand)).rejects.toThrow(
      "preview source promotion broker returned invalid proof",
    );
  });

  it("rejects a known service that was not captured", async () => {
    const capturedCommand: PreviewSourcePromotionBrokerRequest = {
      ...command,
      artifactIdentity: {
        ...identity,
        services: FIVE_CAPTURED_SERVICES.filter(
          (service) => service !== "function-router",
        ),
      },
    };
    const { adapter } = promotionHttpHarness(
      promotionBrokerProof(["function-router"]),
    );

    await expect(adapter.promote(capturedCommand)).rejects.toThrow(
      "preview source promotion broker returned invalid proof",
    );
  });

  it.each([
    ["empty", []],
    ["duplicate", ["workflow-builder", "workflow-builder"]],
    ["out-of-order", ["workflow-orchestrator", "workflow-builder"]],
    ["noncanonical", ["workflow-builder "]],
  ])("rejects a %s changed-service proof", async (_case, services) => {
    const { adapter } = promotionHttpHarness(promotionBrokerProof(services));

    await expect(adapter.promote(fiveServiceCommand)).rejects.toThrow(
      "preview source promotion broker returned invalid proof",
    );
  });
});
