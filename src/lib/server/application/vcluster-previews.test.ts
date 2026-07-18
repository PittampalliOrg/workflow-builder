import { describe, expect, it, vi } from "vitest";
import {
  ApplicationVclusterPreviewService,
  PreviewRuntimeIdentityChangedError,
} from "$lib/server/application/vcluster-previews";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";
import type {
  PreviewAccessPolicyPort,
  PreviewControlIdentity,
  PreviewDeploymentScopePort,
  PreviewEnvironmentObservationReaderPort,
  PreviewEnvironmentTeardownStatusPort,
  PreviewSourcePromotionReceiptListingPort,
  VclusterPreviewGatewayPort,
  VclusterPreviewSleepOutcome,
  VclusterPreviewTouchResult,
} from "$lib/server/application/ports";
import type {
  VclusterPreviewCounts,
  VclusterPreviewRecord,
} from "$lib/types/dev-previews";

function record(
  over: Partial<VclusterPreviewRecord> = {},
): VclusterPreviewRecord {
  return {
    name: "feat-x",
    phase: "ready",
    ready: true,
    url: "https://wfb-feat-x.ts.net",
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: null,
    origin: null,
    legacyOrigin: null,
    prNumber: null,
    expiresAt: null,
    lastActive: null,
    protected: false,
    bootSeconds: null,
    platformRevision: null,
    sourceRevision: null,
    profile: null,
    lane: null,
    mode: null,
    owner: null,
    services: null,
    provenance: null,
    trustedCode: null,
    allocation: null,
    images: null,
    catalogDigest: null,
    ...over,
  };
}

function counts(
  over: Partial<VclusterPreviewCounts> = {},
): VclusterPreviewCounts {
  return {
    awake: 0,
    slept: 0,
    total: 0,
    baking: 0,
    free: 0,
    claimed: 0,
    recycling: 0,
    max: 6,
    totalMax: 0,
    poolSize: 2,
    ...over,
  };
}

type TestPreviewGateway = VclusterPreviewGatewayPort &
  PreviewEnvironmentObservationReaderPort &
  PreviewEnvironmentTeardownStatusPort;

function observedRecord(
  identity: Parameters<PreviewEnvironmentObservationReaderPort["inspect"]>[0],
) {
  return record({
    name: identity.previewName,
    owner: { kind: "user", id: "user-1" },
    platformRevision: identity.environmentPlatformRevision,
    sourceRevision: identity.environmentSourceRevision,
    catalogDigest: identity.catalogDigest,
    provenance: { requestId: identity.environmentRequestId },
  });
}

function gateway(over: Partial<TestPreviewGateway> = {}): TestPreviewGateway {
  return {
    listWithCounts: vi.fn(async () => ({ previews: [], counts: counts() })),
    get: vi.fn(async (name: string) => record({ name })),
    provision: vi.fn(async (input) => record({ name: input.name })),
    teardown: vi.fn(async (name: string) => record({ name })),
    runtime: vi.fn(async (name: string) => ({
      name,
      resourceName: name,
      reconciliationSucceeded: true,
      upJob: {
        name: `vcpreview-up-${name}`,
        found: true,
        active: false,
        succeeded: true,
        failed: false,
      },
      services: [],
    })),
    runtimeForIdentity: vi.fn(async (identity) => ({
      name: identity.previewName,
      resourceName: identity.previewName,
      identity,
      reconciliationSucceeded: true,
      upJob: {
        name: `vcpreview-up-${identity.previewName}`,
        found: true,
        active: false,
        succeeded: true,
        failed: false,
      },
      services: [],
    })),
    inspect: vi.fn(async (identity) => ({
      preview: observedRecord(identity),
      identity,
    })),
    observeRuntime: vi.fn(async (identity) => ({
      preview: observedRecord(identity),
      identity,
      runtime: {
        name: identity.previewName,
        resourceName: identity.previewName,
        identity,
        reconciliationSucceeded: true,
        upJob: {
          name: `vcpreview-up-${identity.previewName}`,
          found: true,
          active: false,
          succeeded: true,
          failed: false,
        },
        services: [],
      },
    })),
    cleanup: vi.fn(async (name: string) => ({
      name,
      resourceName: name,
      complete: false,
      phase: "pending" as const,
      checks: {
        runnerSucceeded: false,
        previewEnvironmentAbsent: false,
        applicationAbsent: false,
        agentRegistrationAbsent: false,
        agentNamespacesAbsent: false,
        databaseAbsent: false,
        natsStreamAbsent: false,
        headlampRegistrationAbsent: false,
        tailnetEgressAbsent: false,
        hostNamespaceAbsent: false,
        storageScopeAbsent: false,
        runnerIdentityAbsent: false,
      },
      message: null,
    })),
    status: vi.fn(async (ticket) => ({
      name: ticket.name,
      resourceName: ticket.name,
      complete: false,
      phase: "pending" as const,
      checks: {
        runnerSucceeded: false,
        previewEnvironmentAbsent: false,
        applicationAbsent: false,
        agentRegistrationAbsent: false,
        agentNamespacesAbsent: false,
        databaseAbsent: false,
        natsStreamAbsent: false,
        headlampRegistrationAbsent: false,
        tailnetEgressAbsent: false,
        hostNamespaceAbsent: false,
        storageScopeAbsent: false,
        runnerIdentityAbsent: false,
      },
      message: null,
    })),
    touch: vi.fn(
      async (name: string): Promise<VclusterPreviewTouchResult> => ({
        name,
        state: "hot",
        resuming: false,
        lastActive: null,
      }),
    ),
    sleep: vi.fn(
      async (name: string): Promise<VclusterPreviewSleepOutcome> => ({
        ok: true,
        name,
        alreadySlept: false,
      }),
    ),
    ...over,
  };
}

const service = (
  gw: TestPreviewGateway,
  access: PreviewAccessPolicyPort = {
    authorize: vi.fn(async ({ name, actorUserId }) => ({
      preview: await gw.get(name),
      ownerId: actorUserId,
      actorIsOwner: true,
      actorIsPlatformAdmin: false,
    })),
  },
  scope: Pick<
    PreviewDeploymentScopePort,
    "isControlPlane" | "allowsPreviewName"
  > = {
    isControlPlane: () => true,
    allowsPreviewName: (_name: string) => true,
  },
) =>
  new ApplicationVclusterPreviewService({
    gateway: gw,
    access,
    scope,
    previewRepo: "PittampalliOrg/workflow-builder",
    maxPreviews: 6,
  });

describe("ApplicationVclusterPreviewService", () => {
  it("keeps fleet operations inside the application control-plane policy", async () => {
    const gw = gateway();
    const scope = {
      isControlPlane: vi.fn(() => false),
      allowsPreviewName: vi.fn((name: string) => name === "feat-x"),
    };
    const svc = service(gw, undefined, scope);

    await expect(svc.list()).rejects.toThrow("unavailable from a preview deployment");
    await expect(svc.launch({ name: "feat-x" })).rejects.toThrow(
      "unavailable from a preview deployment",
    );
    await expect(svc.sleep("feat-x")).rejects.toThrow(
      "unavailable from a preview deployment",
    );
    expect(gw.listWithCounts).not.toHaveBeenCalled();
    expect(gw.sleep).not.toHaveBeenCalled();
  });

  it("keeps exact-name reads inside the application deployment scope", async () => {
    const gw = gateway();
    const scope = {
      isControlPlane: vi.fn(() => false),
      allowsPreviewName: vi.fn((name: string) => name === "feat-x"),
    };
    const svc = service(gw, undefined, scope);

    await expect(svc.get("another-preview")).rejects.toThrow(
      "cross-preview access",
    );
    expect(gw.get).not.toHaveBeenCalled();
  });

  it("presents aggregate launches through the existing Dev-hub DTO", () => {
    const command = validatePreviewEnvironmentLaunchSpec(
      {
        name: "feature-x",
        profile: "app-live",
        lane: "application",
        capabilities: ["service-live-sync"],
        platformRevision: "a".repeat(40),
        sourceRevision: "b".repeat(40),
        services: ["workflow-builder"],
        owner: { kind: "user", id: "user-1" },
        origin: { kind: "user" },
        ttlHours: 24,
        mode: "live",
        lifecycle: "retained",
        allocation: { kind: "cold" },
        provenance: {
          requestId: "request-1",
          requestedAt: "2026-07-09T18:00:00.000Z",
          platformRepository: "PittampalliOrg/stacks",
          sourceRepository: "PittampalliOrg/workflow-builder",
        },
      },
      `sha256:${"c".repeat(64)}`,
    );
    const result = service(gateway()).presentLaunch({
      ok: true,
      environment: {
        ...command,
        id: "feature-x",
        lifecycleState: "provisioning",
        createdAt: "2026-07-09T18:00:00.000Z",
        expiresAt: "2026-07-10T18:00:00.000Z",
        runtime: {
          placement: "dev-vcluster",
          phase: "provisioning",
          ready: false,
          url: "https://wfb-feature-x.example.test",
          allocationId: null,
          pooled: false,
        },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      pooled: false,
      preview: {
        name: "feature-x",
        phase: "provisioning",
        pool: null,
        origin: { kind: "user" },
        prUrl: null,
      },
    });
  });

  it("decorates a pr-origin preview with a GitHub prUrl (null otherwise)", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [
          record({
            name: "pr-42",
            origin: { kind: "pull-request", reference: "42" },
            legacyOrigin: "pr",
            prNumber: 42,
          }),
          record({
            name: "feat-y",
            origin: { kind: "user" },
            legacyOrigin: "user",
          }),
        ],
        counts: counts(),
      })),
    });
    const { previews } = await service(gw).list();
    expect(previews[0].prUrl).toBe(
      "https://github.com/PittampalliOrg/workflow-builder/pull/42",
    );
    expect(previews[1].prUrl).toBeNull();
    expect(gw.cleanup).not.toHaveBeenCalled();
  });

  it("delegates runtime and ticket-bound teardown observations through gateway ports", async () => {
    const authorized = record({
      name: "feature-x",
      owner: { kind: "user", id: "user-1" },
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
      provenance: { requestId: "request-1" },
    });
    const gw = gateway({ get: vi.fn(async () => authorized) });
    const access: PreviewAccessPolicyPort = {
      authorize: vi.fn(async () => ({
        preview: authorized,
        ownerId: "user-1",
        actorIsOwner: true,
        actorIsPlatformAdmin: false,
      })),
    };
    const svc = service(gw, access);

    await expect(
      svc.observeRuntime({ name: "feature-x", actorUserId: "user-1" }),
    ).resolves.toEqual({
      name: "feature-x",
      reconciliationSucceeded: true,
      provision: {
        found: true,
        active: false,
        succeeded: true,
        failed: false,
      },
      services: [],
    });
    const ticket = {
      name: "feature-x",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    };
    await expect(svc.teardownStatus(ticket)).resolves.toMatchObject({
      name: "feature-x",
      phase: "pending",
    });
    expect(access.authorize).toHaveBeenCalledWith({
      name: "feature-x",
      actorUserId: "user-1",
    });
    expect(gw.observeRuntime).toHaveBeenCalledWith({
      previewName: "feature-x",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "a".repeat(40),
      environmentSourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
    });
    expect(gw.get).not.toHaveBeenCalled();
    expect(gw.status).toHaveBeenCalledWith(ticket);
  });

  it("rejects a runtime observation when the authorized preview identity changed", async () => {
    const authorized = record({
      owner: { kind: "user", id: "user-1" },
      platformRevision: "a".repeat(40),
      sourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
      provenance: { requestId: "request-1" },
    });
    const replacement = record({
      ...authorized,
      owner: { kind: "user", id: "user-2" },
      provenance: { requestId: "request-2" },
    });
    const gw = gateway();
    const controlIdentity: PreviewControlIdentity = {
      previewName: authorized.name,
      environmentRequestId: "request-1",
      environmentPlatformRevision: "a".repeat(40),
      environmentSourceRevision: "b".repeat(40),
      catalogDigest: `sha256:${"c".repeat(64)}`,
    };
    const baseline = await gw.observeRuntime(controlIdentity);
    vi.mocked(gw.observeRuntime).mockClear();
    vi.mocked(gw.observeRuntime).mockResolvedValueOnce({
      ...baseline,
      preview: replacement,
    });
    const access: PreviewAccessPolicyPort = {
      authorize: vi.fn(async () => ({
        preview: authorized,
        ownerId: "user-1",
        actorIsOwner: true,
        actorIsPlatformAdmin: false,
      })),
    };

    await expect(
      service(gw, access).observeRuntime({
        name: "feat-x",
        actorUserId: "user-1",
      }),
    ).rejects.toBeInstanceOf(PreviewRuntimeIdentityChangedError);
  });

  it("cold-provisions when there is headroom", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [],
        counts: counts({ awake: 2, max: 6 }),
      })),
    });
    const result = await service(gw).launch({ name: "feat-x" });
    expect(result.ok && !result.pooled).toBe(true);
    expect(gw.provision).toHaveBeenCalledWith({ name: "feat-x" });
  });

  it("refuses AS DATA when awake >= max (no throw)", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [],
        counts: counts({ awake: 6, max: 6 }),
      })),
    });
    const result = await service(gw).launch({ name: "feat-x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("capacity");
      if (result.reason === "capacity") {
        expect(result.awake).toBe(6);
        expect(result.max).toBe(6);
      }
    }
    expect(gw.provision).not.toHaveBeenCalled();
  });

  it("allows re-provisioning an EXISTING preview even at capacity", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [record({ name: "feat-x" })],
        counts: counts({ awake: 6, max: 6 }),
      })),
    });
    const result = await service(gw).launch({ name: "feat-x" });
    expect(result.ok).toBe(true);
    expect(gw.provision).toHaveBeenCalled();
  });

  it("falls back to the configured max when the SEA omits counts", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [
          record({ name: "a" }),
          record({ name: "b" }),
          record({ name: "c" }),
        ],
        counts: null,
      })),
    });
    // config max = 6, 3 awake (previews.length) < 6 → provisions
    const svc = new ApplicationVclusterPreviewService({
      gateway: gw,
      access: {
        authorize: vi.fn(async ({ name, actorUserId }) => ({
          preview: await gw.get(name),
          ownerId: actorUserId,
          actorIsOwner: true,
          actorIsPlatformAdmin: false,
        })),
      },
      scope: {
        isControlPlane: () => true,
        allowsPreviewName: () => true,
      },
      previewRepo: "o/r",
      maxPreviews: 6,
    });
    const ok = await svc.launch({ name: "feat-x" });
    expect(ok.ok).toBe(true);
    // Same list at cap=3 → refused.
    const capped = new ApplicationVclusterPreviewService({
      gateway: gw,
      access: {
        authorize: vi.fn(async ({ name, actorUserId }) => ({
          preview: await gw.get(name),
          ownerId: actorUserId,
          actorIsOwner: true,
          actorIsPlatformAdmin: false,
        })),
      },
      scope: {
        isControlPlane: () => true,
        allowsPreviewName: () => true,
      },
      previewRepo: "o/r",
      maxPreviews: 3,
    });
    const refused = await capped.launch({ name: "feat-x" });
    expect(refused.ok).toBe(false);
  });

  it("classifies a sleep 409 into protected vs pool-member", async () => {
    const protectedGw = gateway({
      sleep: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        detail: "preview is protected",
      })),
    });
    const poolGw = gateway({
      sleep: vi.fn(async () => ({
        ok: false as const,
        status: 409,
        detail: "free pool members stay claim-ready (never slept)",
      })),
    });
    expect(await service(protectedGw).sleep("p")).toEqual({
      ok: false,
      reason: "protected",
      message: "preview is protected",
    });
    expect(await service(poolGw).sleep("m")).toEqual({
      ok: false,
      reason: "pool-member",
      message: "free pool members stay claim-ready (never slept)",
    });
  });

  it("throws on a non-409 sleep failure", async () => {
    const gw = gateway({
      sleep: vi.fn(async () => ({
        ok: false as const,
        status: 500,
        detail: "sleep failed",
      })),
    });
    await expect(service(gw).sleep("x")).rejects.toThrow("sleep failed");
  });

  it("wake returns the resume flag from a touch", async () => {
    const gw = gateway({
      touch: vi.fn(async (name: string) => ({
        name,
        state: "slept",
        resuming: true,
        lastActive: "2026-07-05T00:00:00Z",
      })),
    });
    expect(await service(gw).wake("feat-x")).toEqual({
      name: "feat-x",
      state: "slept",
      resuming: true,
    });
  });

  it("resolves the host->preview API base URL from the backing pool member", () => {
    const svc = service(gateway());
    expect(
      svc.apiBaseUrl({
        name: "feat-x",
        url: "https://wfb-feat-x.ts.net",
        pool: "pool-2",
      }),
    ).toBe(
      "http://workflow-builder-x-workflow-builder-x-pool-2.vcluster-pool-2.svc.cluster.local:3000",
    );
    expect(
      svc.apiBaseUrl({ name: "feat-x", url: null, pool: null }),
    ).toBe(
      "http://workflow-builder-x-workflow-builder-x-feat-x.vcluster-feat-x.svc.cluster.local:3000",
    );
  });

  describe("listPromotionReceipts", () => {
    const receiptRow = (over: {
      previewName?: string;
      executionId?: string;
      pullRequestNumber?: number;
      createdAt?: string;
    }) => ({
      previewName: "feat-x",
      executionId: "execution-1",
      pullRequestNumber: 42,
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      commitSha: "c".repeat(40),
      createdAt: "2026-07-16T10:00:00.000Z",
      ...over,
    });

    const receiptsService = (
      listRecentByPreview: PreviewSourcePromotionReceiptListingPort["listRecentByPreview"],
    ) =>
      new ApplicationVclusterPreviewService({
        gateway: gateway(),
        access: {
          authorize: vi.fn(async () => {
            throw new Error("unused");
          }),
        },
        scope: {
          isControlPlane: () => true,
          allowsPreviewName: () => true,
        },
        previewRepo: "PittampalliOrg/workflow-builder",
        maxPreviews: 6,
        receipts: { listRecentByPreview },
      });

    it("groups newest-first receipts and execution ids per preview", async () => {
      const listRecentByPreview = vi.fn(async () => [
        receiptRow({ executionId: "execution-2", pullRequestNumber: 43 }),
        receiptRow({ createdAt: "2026-07-15T10:00:00.000Z" }),
        receiptRow({
          previewName: "feat-y",
          executionId: "execution-2",
          pullRequestNumber: 41,
        }),
        // Same execution again: listed once in executionIdsByPreview.
        receiptRow({
          executionId: "execution-2",
          pullRequestNumber: 40,
          createdAt: "2026-07-14T10:00:00.000Z",
        }),
      ]);

      const listing = await receiptsService(listRecentByPreview)
        .listPromotionReceipts(["feat-x", "feat-x", "feat-y", ""]);

      expect(listRecentByPreview).toHaveBeenCalledWith({
        previewNames: ["feat-x", "feat-y"],
        limitPerPreview: 10,
      });
      expect(
        listing.receiptsByPreview
          .get("feat-x")
          ?.map((receipt) => receipt.prNumber),
      ).toEqual([43, 42, 40]);
      expect(listing.receiptsByPreview.get("feat-x")?.[0]).toEqual({
        prNumber: 43,
        prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
        commitSha: "c".repeat(40),
        createdAt: "2026-07-16T10:00:00.000Z",
      });
      expect(listing.executionIdsByPreview.get("feat-x")).toEqual([
        "execution-2",
        "execution-1",
      ]);
      expect(listing.executionIdsByPreview.get("feat-y")).toEqual([
        "execution-2",
      ]);
    });

    it("degrades to empty maps when the listing is unavailable", async () => {
      const listRecentByPreview = vi.fn(async () => {
        throw new Error("database unavailable");
      });
      const listing = await receiptsService(listRecentByPreview)
        .listPromotionReceipts(["feat-x"]);
      expect(listing.receiptsByPreview.size).toBe(0);
      expect(listing.executionIdsByPreview.size).toBe(0);
    });

    it("answers an empty name set without touching the listing port", async () => {
      const listRecentByPreview = vi.fn(async () => []);
      const listing = await receiptsService(listRecentByPreview)
        .listPromotionReceipts(["", ""]);
      expect(listRecentByPreview).not.toHaveBeenCalled();
      expect(listing.receiptsByPreview.size).toBe(0);
    });
  });
});
