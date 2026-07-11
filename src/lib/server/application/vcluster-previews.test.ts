import { describe, expect, it, vi } from "vitest";
import { ApplicationVclusterPreviewService } from "$lib/server/application/vcluster-previews";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";
import type {
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

function gateway(
  over: Partial<VclusterPreviewGatewayPort> = {},
): VclusterPreviewGatewayPort {
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

const service = (gw: VclusterPreviewGatewayPort) =>
  new ApplicationVclusterPreviewService({
    gateway: gw,
    previewRepo: "PittampalliOrg/workflow-builder",
    maxPreviews: 6,
  });

describe("ApplicationVclusterPreviewService", () => {
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
      previewRepo: "o/r",
      maxPreviews: 6,
    });
    const ok = await svc.launch({ name: "feat-x" });
    expect(ok.ok).toBe(true);
    // Same list at cap=3 → refused.
    const capped = new ApplicationVclusterPreviewService({
      gateway: gw,
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
});
