import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewSourcePromotionAcceptanceService,
  PreviewSourcePromotionAcceptanceError,
} from "$lib/server/application/preview-source-promotion-acceptance";
import { HttpPreviewSourcePromotionAcceptanceAdapter } from "$lib/server/application/adapters/preview-source-promotion-acceptance";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const LIVE_BASE_SHA = "f".repeat(40);
const CATALOG = `sha256:${"d".repeat(64)}` as const;
const RECEIPT_ID = `pspr_${"e".repeat(64)}`;

function command() {
  return {
    requestId: "request-command-1",
    previewName: "app-live",
    environmentRequestId: "environment-request-1",
    environmentPlatformRevision: PLATFORM_SHA,
    environmentSourceRevision: SOURCE_SHA,
    catalogDigest: CATALOG,
    executionId: "execution-1",
    receiptId: RECEIPT_ID,
  };
}

function harness(
  receipt: Record<string, unknown> | null = {},
  livePullRequest: Record<string, unknown> = {},
) {
  const receipts = {
    getScoped: vi.fn(async () =>
      receipt === null
        ? null
        : {
            receiptId: RECEIPT_ID,
            repository: "PittampalliOrg/workflow-builder",
            pullRequestNumber: 42,
            baseSha: SOURCE_SHA,
            branch: "preview/app-live-execution-1",
            commitSha: HEAD_SHA,
            draft: true,
            changedPaths: ["src/routes/demo/+page.svelte"],
            ...receipt,
          },
    ),
  };
  const pullRequests = {
    inspectOpen: vi.fn(async () => ({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      draft: true,
      baseSha: LIVE_BASE_SHA,
      headRef: "preview/app-live-execution-1",
      headSha: HEAD_SHA,
      changedPaths: ["src/routes/demo/+page.svelte"],
      ...livePullRequest,
    })),
    inspect: vi.fn(),
  };
  const acceptance = {
    replay: vi.fn(async (input) => ({
      ok: true,
      name: `accept-pr42-${HEAD_SHA.slice(0, 12)}`,
      previewName: input.previewName,
      pullRequest: input.pullRequest,
      services: ["workflow-builder"],
    })),
  };
  const service = new ApplicationPreviewSourcePromotionAcceptanceService({
    receipts: receipts as never,
    pullRequests: pullRequests as never,
    acceptance: acceptance as never,
    sourceRepository: "PittampalliOrg/workflow-builder",
    baseBranch: "main",
  });
  return { service, receipts, pullRequests, acceptance };
}

describe("ApplicationPreviewSourcePromotionAcceptanceService", () => {
  it("keeps the receipt head immutable while delegating the live advanced base", async () => {
    const h = harness();

    await expect(h.service.replay(command())).resolves.toMatchObject({
      ok: true,
      previewName: "app-live",
    });
    expect(h.receipts.getScoped).toHaveBeenCalledWith({
      receiptId: RECEIPT_ID,
      previewName: "app-live",
      requestId: "environment-request-1",
      executionId: "execution-1",
      platformRevision: PLATFORM_SHA,
      sourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG,
      repository: "PittampalliOrg/workflow-builder",
      baseBranch: "main",
    });
    expect(h.acceptance.replay).toHaveBeenCalledWith({
      requestId: "request-command-1",
      previewName: "app-live",
      environmentRequestId: "environment-request-1",
      environmentPlatformRevision: PLATFORM_SHA,
      environmentSourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG,
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: LIVE_BASE_SHA,
        headSha: HEAD_SHA,
      },
    });
    expect(h.pullRequests.inspectOpen).toHaveBeenCalledWith({
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
    });
  });

  it("accepts a URL-safe Nanoid workflow execution identity", async () => {
    const h = harness();
    const executionId = "_O-r4CT3dAp9CRUi7ImCA";

    await expect(
      h.service.replay({ ...command(), executionId }),
    ).resolves.toMatchObject({ ok: true, previewName: "app-live" });
    expect(h.receipts.getScoped).toHaveBeenCalledWith(
      expect.objectContaining({ executionId }),
    );
  });

  it.each([
    ["head", { headSha: "9".repeat(40) }],
    ["branch", { headRef: "preview/other" }],
    ["draft state", { draft: false }],
    ["changed paths", { changedPaths: ["src/routes/other/+page.svelte"] }],
  ])("rejects a live pull request with changed %s", async (_label, live) => {
    const h = harness({}, live);

    await expect(h.service.replay(command())).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(h.acceptance.replay).not.toHaveBeenCalled();
  });

  it("fails closed for missing or non-draft receipts", async () => {
    for (const receipt of [null, { draft: false }]) {
      const h = harness(receipt);
      await expect(h.service.replay(command())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(h.acceptance.replay).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed opaque identifiers before reading the store", async () => {
    const h = harness();
    await expect(
      h.service.replay({ ...command(), receiptId: "../receipt" }),
    ).rejects.toBeInstanceOf(PreviewSourcePromotionAcceptanceError);
    expect(h.receipts.getScoped).not.toHaveBeenCalled();
  });
});

describe("HttpPreviewSourcePromotionAcceptanceAdapter", () => {
  const failure = {
    ok: false,
    name: `accept-pr42-${HEAD_SHA.slice(0, 12)}`,
    previewName: "app-live",
    pullRequest: {
      repository: "PittampalliOrg/workflow-builder",
      number: 42,
      baseSha: SOURCE_SHA,
      headSha: HEAD_SHA,
    },
    services: ["workflow-builder"],
    stage: "freshness",
    message: "preview source changed",
  };
  const catalog = {
    listPreviewNativeServices: () => ["workflow-builder"],
    assertPreviewNativeServices: (services: readonly string[]) => services,
    assertAcceptanceReplayServices: (services: readonly string[]) => services,
    acceptanceImageRepository: () =>
      "ghcr.io/pittampalliorg/workflow-builder",
  };

  function adapter(boundReceipt: string | null) {
    return new HttpPreviewSourcePromotionAcceptanceAdapter({
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "leaf-token",
      identity: () => ({
        previewName: "app-live",
        environmentRequestId: "environment-request-1",
        environmentPlatformRevision: PLATFORM_SHA,
        environmentSourceRevision: SOURCE_SHA,
        catalogDigest: CATALOG,
      }),
      catalog,
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify(failure), {
            status: 422,
            headers: boundReceipt
              ? { "X-Preview-Promotion-Receipt": boundReceipt }
              : {},
          }),
      ) as typeof fetch,
    });
  }

  it("accepts a physical response bound to the requested receipt", async () => {
    await expect(adapter(RECEIPT_ID).replay(command())).resolves.toMatchObject({
      ok: false,
      pullRequest: { number: 42, headSha: HEAD_SHA },
    });
  });

  it.each([null, `pspr_${"f".repeat(64)}`])(
    "rejects a physical response with receipt binding %s",
    async (boundReceipt) => {
      await expect(adapter(boundReceipt).replay(command())).rejects.toThrow(
        "response is not bound to its receipt",
      );
    },
  );
});
