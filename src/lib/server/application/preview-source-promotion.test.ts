import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewSourcePromotionBrokerService,
  ApplicationPreviewSourcePromotionService,
  previewSourcePromotionBranch,
} from "$lib/server/application/preview-source-promotion";
import { HttpPreviewSourcePromotionBrokerAdapter } from "$lib/server/application/adapters/preview-control";
import type {
  ImmutableGitSha,
  PreviewImportedArtifactIdentity,
  PreviewSourcePromotionBrokerRequest,
} from "$lib/server/application/ports";
import { PreviewSourcePromotionExclusivityBusyError } from "$lib/server/application/ports";

const PLATFORM = "a".repeat(40) as ImmutableGitSha;
const SOURCE = "b".repeat(40) as ImmutableGitSha;
const COMMIT = "c".repeat(40) as ImmutableGitSha;
const COMMIT_2 = "9".repeat(40) as ImmutableGitSha;
const ADVANCED_BASE = "f".repeat(40) as ImmutableGitSha;
const CATALOG = `sha256:${"d".repeat(64)}` as const;
const FILE = `sha256:${"e".repeat(64)}` as const;
const RECEIPT_ID = `pspr_${"f".repeat(64)}`;
const BRANCH = previewSourcePromotionBranch({
  previewName: "preview-one",
  requestId: "request-1",
  executionId: "execution-1",
  platformRevision: PLATFORM,
  sourceRevision: SOURCE,
  catalogDigest: CATALOG,
  repository: "PittampalliOrg/workflow-builder",
  baseBranch: "main",
});
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

function promotionBrokerProof(
  services: readonly string[],
  baseSha: ImmutableGitSha = SOURCE,
) {
  return {
    ok: true,
    receiptId: RECEIPT_ID,
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
      draft: true,
      baseSha,
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

function testExclusivity() {
  const tails = new Map<string, Promise<void>>();
  return {
    runExclusive: vi.fn(
      async <T>(
        scope: Record<string, unknown>,
        operation: () => Promise<T>,
      ): Promise<T> => {
        const key = JSON.stringify(scope);
        const previous = tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        tails.set(key, previous.then(() => current));
        await previous;
        try {
          return await operation();
        } finally {
          release();
        }
      },
    ),
  };
}

function brokerHarness() {
  let storedReceipt: Record<string, unknown> | null = null;
  let pullRequestHead: ImmutableGitSha = COMMIT;
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
    preparePromotion: vi.fn(async (input: {
      artifact: {
        artifactId: string;
        identity: PreviewImportedArtifactIdentity;
      };
    }) => ({
      artifactId: input.artifact.artifactId,
      artifactIdentity: input.artifact.identity,
      fileId: `file-${input.artifact.artifactId}`,
      fileDigest: input.artifact.identity.fileDigest,
      services: input.artifact.identity.services,
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
  const inspectOpen = vi.fn(async () => ({
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    draft: true,
    baseSha: SOURCE,
    headRef: BRANCH,
    headSha: pullRequestHead,
    changedPaths: ["src/routes/feature.ts"],
  }));
  const pullRequests = {
    inspectOpen,
    inspect: vi.fn(async (input: {
      repository: string;
      number: number;
      baseSha: ImmutableGitSha;
      headSha: ImmutableGitSha;
    }) => {
      const pullRequest = await inspectOpen();
      if (
        pullRequest.repository !== input.repository ||
        pullRequest.number !== input.number ||
        pullRequest.baseSha !== input.baseSha ||
        pullRequest.headSha !== input.headSha
      ) {
        throw new Error(
          "GitHub pull request repo/base/head identity does not match",
        );
      }
      return pullRequest;
    }),
  };
  const receipts = {
    getByArtifact: vi.fn(async (artifactId: string) =>
      storedReceipt?.artifactId === artifactId ? storedReceipt : null,
    ),
    getScoped: vi.fn(async () => storedReceipt),
    getLatestForExecution: vi.fn(async () => storedReceipt),
    put: vi.fn(async (value: Record<string, unknown>) => {
      storedReceipt = {
        ...value,
        receiptId: `pspr_${(value.artifactId === "central-artifact-1" ? "f" : "a").repeat(64)}`,
        createdAt: "2026-07-14T12:00:00.000Z",
      };
      return storedReceipt;
    }),
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
  const exclusivity = testExclusivity();
  return {
    authority,
    trust,
    promotions,
    git,
    pullRequests,
    receipts,
    exclusivity,
    catalog,
    setPullRequestHead: (head: ImmutableGitSha) => {
      pullRequestHead = head;
    },
    service: new ApplicationPreviewSourcePromotionBrokerService({
      authority: authority as never,
      trust,
      promotions,
      git,
      pullRequests,
      receipts: receipts as never,
      exclusivity: exclusivity as never,
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
        receiptId: RECEIPT_ID,
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
      expectedBaseSnapshot: SOURCE,
      expectedChangedPaths: ["src/routes/feature.ts"],
    });
    expect(h.pullRequests.inspectOpen).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
    });
    expect(h.pullRequests.inspect).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: SOURCE,
      headSha: COMMIT,
    });
  });

  it("single-flights concurrent retries before the Git and receipt mutation", async () => {
    const h = brokerHarness();
    let releasePromotion!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    const result = await h.promotions.promoteSourceBundle();
    h.promotions.promoteSourceBundle.mockClear();
    h.promotions.promoteSourceBundle.mockImplementationOnce(async () => {
      await blocked;
      return result;
    });

    const first = h.service.promote(command);
    await vi.waitFor(() => {
      expect(h.promotions.promoteSourceBundle).toHaveBeenCalledOnce();
    });
    const second = h.service.promote(command);
    await vi.waitFor(() => {
      expect(h.exclusivity.runExclusive).toHaveBeenCalledTimes(2);
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledOnce();
    releasePromotion();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledOnce();
    expect(h.receipts.put).toHaveBeenCalledTimes(1);
    expect(h.exclusivity.runExclusive).toHaveBeenCalledTimes(2);
  });

  it("maps lock contention to a retryable promotion response", async () => {
    const h = brokerHarness();
    h.exclusivity.runExclusive.mockRejectedValueOnce(
      new PreviewSourcePromotionExclusivityBusyError(),
    );

    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "promotion-busy",
      statusCode: 409,
      message: "preview source promotion is busy; retry the checkpoint",
    });
    expect(h.promotions.promoteSourceBundle).not.toHaveBeenCalled();
  });

  it("leases the first receipt when a later generation queues for the same PR", async () => {
    const h = brokerHarness();
    const laterIdentity: PreviewImportedArtifactIdentity = {
      ...identity,
      sourceArtifactId: "source-artifact-2",
      captureId: "capture-2",
      generation: "generation-2",
      fileDigest: `sha256:${"1".repeat(64)}`,
    };
    const laterCommand: PreviewSourcePromotionBrokerRequest = {
      ...command,
      operationId: "central-artifact-2",
      artifactId: "central-artifact-2",
      artifactIdentity: laterIdentity,
    };
    const firstPromotion = await h.promotions.promoteSourceBundle();
    h.promotions.promoteSourceBundle.mockClear();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    h.promotions.promoteSourceBundle
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return firstPromotion;
      })
      .mockImplementationOnce(async () => {
        h.setPullRequestHead(COMMIT_2);
        return { ...firstPromotion, commitSha: COMMIT_2 };
      });

    const first = h.service.promote(command);
    await vi.waitFor(() => {
      expect(h.promotions.promoteSourceBundle).toHaveBeenCalledOnce();
    });
    const second = h.service.promote(laterCommand);
    await vi.waitFor(() => {
      expect(h.exclusivity.runExclusive).toHaveBeenCalledTimes(2);
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledOnce();
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.commitSha).toBe(COMMIT);
    expect(secondResult.commitSha).toBe(COMMIT_2);
    expect(h.promotions.promoteSourceBundle).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        branchLease: {
          expectedHeadSha: COMMIT,
          existingPullRequestNumber: 42,
        },
      }),
    );
    expect(h.receipts.put).toHaveBeenCalledTimes(2);
  });

  it("does not persist a PR base that moves after ancestry verification", async () => {
    const h = brokerHarness();
    h.pullRequests.inspectOpen
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: SOURCE,
        headRef: BRANCH,
        headSha: COMMIT,
        changedPaths: ["src/routes/feature.ts"],
      })
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: ADVANCED_BASE,
        headRef: BRANCH,
        headSha: COMMIT,
        changedPaths: ["src/routes/feature.ts"],
      });

    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "materialization-failed",
      statusCode: 409,
    });
    expect(h.receipts.put).not.toHaveBeenCalled();
  });

  it("replays a stored artifact after the PR target branch advances", async () => {
    const h = brokerHarness();
    await h.service.promote(command);
    h.pullRequests.inspectOpen.mockResolvedValue({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      draft: true,
      baseSha: ADVANCED_BASE,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    });

    await expect(h.service.promote(command)).resolves.toMatchObject({
      receiptId: RECEIPT_ID,
      commitSha: COMMIT,
      pullRequest: {
        baseSha: SOURCE,
        headSha: COMMIT,
      },
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledTimes(1);
    expect(h.git.verifyBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseRevision: SOURCE,
        commitSha: COMMIT,
      }),
    );
  });

  it("reuses one leased draft branch and pull request for later checkpoints", async () => {
    const h = brokerHarness();
    await h.service.promote(command);

    const nextCommit = "1".repeat(40) as ImmutableGitSha;
    const nextIdentity: PreviewImportedArtifactIdentity = {
      ...identity,
      sourceArtifactId: "source-artifact-2",
      captureId: "capture-2",
      generation: "generation-2",
      fileDigest: `sha256:${"2".repeat(64)}`,
    };
    const nextCommand: PreviewSourcePromotionBrokerRequest = {
      ...command,
      operationId: "central-artifact-2",
      artifactId: "central-artifact-2",
      artifactIdentity: nextIdentity,
    };
    h.trust.preparePromotion.mockResolvedValueOnce({
      artifactId: "central-artifact-2",
      artifactIdentity: nextIdentity,
      fileId: "file-2",
      fileDigest: nextIdentity.fileDigest,
      services: ["workflow-builder"],
      catalogDigest: CATALOG,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: SOURCE,
      platformRevision: PLATFORM,
    });
    h.pullRequests.inspectOpen
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: ADVANCED_BASE,
        headRef: BRANCH,
        headSha: COMMIT,
        changedPaths: ["src/routes/feature.ts"],
      })
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: ADVANCED_BASE,
        headRef: BRANCH,
        headSha: nextCommit,
        changedPaths: ["src/routes/feature.ts"],
      })
      .mockResolvedValueOnce({
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        draft: true,
        baseSha: ADVANCED_BASE,
        headRef: BRANCH,
        headSha: nextCommit,
        changedPaths: ["src/routes/feature.ts"],
      });
    h.promotions.promoteSourceBundle.mockResolvedValueOnce({
      status: "ok",
      output: "",
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      branch: BRANCH,
      commitSha: nextCommit,
      baseRevision: SOURCE,
      pullRequestBase: "main",
      changedPaths: ["src/routes/feature.ts"],
      prError: null,
    });

    await expect(h.service.promote(nextCommand)).resolves.toMatchObject({
      receiptId: `pspr_${"a".repeat(64)}`,
      branch: BRANCH,
      commitSha: nextCommit,
      pullRequest: { number: 42, baseSha: ADVANCED_BASE },
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branchName: BRANCH,
        branchLease: {
          expectedHeadSha: COMMIT,
          existingPullRequestNumber: 42,
        },
        draft: true,
      }),
    );
    expect(h.git.verifyBranch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseRevision: SOURCE,
        commitSha: nextCommit,
      }),
    );
    expect(h.receipts.put).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceRevision: SOURCE,
        baseSha: ADVANCED_BASE,
        commitSha: nextCommit,
      }),
    );
  });

  it("recovers a deterministic leased head after its receipt write failed", async () => {
    const h = brokerHarness();
    await h.service.promote(command);

    const nextCommit = "1".repeat(40) as ImmutableGitSha;
    const nextIdentity: PreviewImportedArtifactIdentity = {
      ...identity,
      sourceArtifactId: "source-artifact-2",
      captureId: "capture-2",
      generation: "generation-2",
      fileDigest: `sha256:${"2".repeat(64)}`,
    };
    const nextCommand: PreviewSourcePromotionBrokerRequest = {
      ...command,
      operationId: "central-artifact-2",
      artifactId: "central-artifact-2",
      artifactIdentity: nextIdentity,
    };
    h.trust.preparePromotion.mockResolvedValue({
      artifactId: "central-artifact-2",
      artifactIdentity: nextIdentity,
      fileId: "file-2",
      fileDigest: nextIdentity.fileDigest,
      services: ["workflow-builder"],
      catalogDigest: CATALOG,
      repo: "PittampalliOrg/workflow-builder",
      base: "main",
      capturedSourceRevision: SOURCE,
      platformRevision: PLATFORM,
    });
    h.promotions.promoteSourceBundle.mockResolvedValue({
      status: "ok",
      output: "",
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      branch: BRANCH,
      commitSha: nextCommit,
      baseRevision: SOURCE,
      pullRequestBase: "main",
      changedPaths: ["src/routes/feature.ts"],
      prError: null,
    });
    const oldPullRequest = {
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      draft: true,
      baseSha: SOURCE,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    };
    const advancedPullRequest = {
      ...oldPullRequest,
      headSha: nextCommit,
    };
    h.pullRequests.inspectOpen
      .mockResolvedValue(advancedPullRequest)
      .mockResolvedValueOnce(oldPullRequest)
      .mockResolvedValueOnce(advancedPullRequest);
    h.receipts.put.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(h.service.promote(nextCommand)).rejects.toMatchObject({
      code: "materialization-failed",
      statusCode: 502,
    });
    await expect(h.service.promote(nextCommand)).resolves.toMatchObject({
      receiptId: `pspr_${"a".repeat(64)}`,
      commitSha: nextCommit,
      pullRequest: { number: 42 },
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledTimes(3);
    expect(h.promotions.promoteSourceBundle).toHaveBeenLastCalledWith(
      expect.objectContaining({
        branchLease: {
          expectedHeadSha: COMMIT,
          existingPullRequestNumber: 42,
        },
      }),
    );
  });

  it("refuses to update a pull request after it leaves draft state", async () => {
    const h = brokerHarness();
    await h.service.promote(command);
    h.pullRequests.inspectOpen.mockResolvedValueOnce({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      draft: false,
      baseSha: SOURCE,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    });

    await expect(h.service.promote(command)).rejects.toMatchObject({
      code: "materialization-failed",
      statusCode: 409,
    });
    expect(h.promotions.promoteSourceBundle).toHaveBeenCalledTimes(1);
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
      draft: true,
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

  it("accepts an advanced PR base while preserving captured ancestry", async () => {
    const h = brokerHarness();
    h.pullRequests.inspectOpen.mockResolvedValue({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      draft: true,
      baseSha: ADVANCED_BASE,
      headRef: BRANCH,
      headSha: COMMIT,
      changedPaths: ["src/routes/feature.ts"],
    });
    await expect(h.service.promote(command)).resolves.toMatchObject({
      commitSha: COMMIT,
      pullRequest: {
        baseSha: ADVANCED_BASE,
        headSha: COMMIT,
      },
    });
    expect(h.git.verifyBranch).toHaveBeenCalledWith(
      expect.objectContaining({ baseRevision: SOURCE }),
    );
    expect(h.receipts.put).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRevision: SOURCE,
        baseSha: ADVANCED_BASE,
      }),
    );
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

  it("accepts a live PR base that advanced beyond the captured source revision", async () => {
    const { adapter } = promotionHttpHarness(
      promotionBrokerProof(["workflow-builder"], ADVANCED_BASE),
    );

    await expect(adapter.promote(command)).resolves.toMatchObject({
      pullRequest: {
        baseSha: ADVANCED_BASE,
        headSha: COMMIT,
      },
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

  it("rejects a malformed physical promotion receipt", async () => {
    const { adapter } = promotionHttpHarness({
      ...promotionBrokerProof(["workflow-builder"]),
      receiptId: "artifact-controlled-receipt",
    });

    await expect(adapter.promote(command)).rejects.toThrow(
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
