import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewControlSourceAuthorityService } from "$lib/server/application/preview-control-source-authority";
import type {
  PreviewControlAdminAuthorizationPort,
  PreviewControlEnvironmentRecord,
  PreviewControlEnvironmentInspectionPort,
  PreviewEnvironmentAcceptanceCatalogPort,
  PreviewEnvironmentVersionedServiceCatalogPort,
} from "$lib/server/application/ports";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;

function harness(overrides: Record<string, unknown> = {}) {
  const environments: PreviewControlEnvironmentInspectionPort = {
    inspect: vi.fn(
      async (name): Promise<PreviewControlEnvironmentRecord> => ({
        name,
        exists: true,
        ready: true,
        owner: "admin-1",
        profile: "app-live",
        mode: "live",
        trustedCode: true,
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
        catalogDigest: CATALOG_DIGEST,
        services: ["function-router", "workflow-builder"],
        provenance: {
          requestId: "launch-1",
          requestedAt: "2026-07-09T20:00:00.000Z",
          platformRepository: "PittampalliOrg/stacks",
          sourceRepository: "PittampalliOrg/workflow-builder",
        },
        ...overrides,
      }),
    ),
  };
  const admins: PreviewControlAdminAuthorizationPort = {
    isPlatformAdmin: vi.fn(async () => true),
  };
  const catalog: PreviewEnvironmentVersionedServiceCatalogPort &
    PreviewEnvironmentAcceptanceCatalogPort = {
    currentDigest: () => CATALOG_DIGEST,
    listPreviewNativeServices: () => ["function-router", "workflow-builder"],
    assertPreviewNativeServices: (services) => {
      if (services.includes("sandbox-execution-api")) {
        throw new Error("not hot-sync preview-native");
      }
      return [...services].sort();
    },
    assertAcceptanceReplayServices: (services) => [...services].sort(),
  };
  return {
    environments,
    admins,
    service: new ApplicationPreviewControlSourceAuthorityService({
      environments,
      admins,
      catalog,
      expectedPlatformRepository: "PittampalliOrg/stacks",
      expectedSourceRepository: "PittampalliOrg/workflow-builder",
    }),
  };
}

const input = {
  previewName: "preview1",
  environmentRequestId: "launch-1",
  environmentPlatformRevision: PLATFORM_SHA,
  environmentSourceRevision: SOURCE_SHA,
  catalogDigest: CATALOG_DIGEST,
  requiredServices: ["workflow-builder"],
};

describe("ApplicationPreviewControlSourceAuthorityService", () => {
  it("derives an authorized central-admin owner from exact physical SEA state", async () => {
    const h = harness();
    await expect(h.service.authorize(input)).resolves.toEqual({
      previewName: "preview1",
      requestId: "launch-1",
      owner: "admin-1",
      platformRevision: PLATFORM_SHA,
      sourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
      services: ["workflow-builder"],
    });
    expect(h.admins.isPlatformAdmin).toHaveBeenCalledWith("admin-1");
  });

  it("authorizes acceptance-only workloads without treating them as hot-sync selections", async () => {
    const h = harness();
    await expect(
      h.service.authorize({
        ...input,
        requiredServices: ["sandbox-execution-api"],
      }),
    ).resolves.toMatchObject({ services: ["sandbox-execution-api"] });
    await expect(
      h.service.authorizeCurrent({
        previewName: input.previewName,
        requiredServices: ["sandbox-execution-api"],
      }),
    ).rejects.toThrow(/not hot-sync preview-native/);
  });

  it.each([
    ["profile", { profile: "manifest-candidate" }],
    ["mode", { mode: "reconciled" }],
    ["trustedCode", { trustedCode: false }],
    ["platformRevision", { platformRevision: "d".repeat(40) }],
    ["sourceRevision", { sourceRevision: "e".repeat(40) }],
    ["catalogDigest", { catalogDigest: `sha256:${"f".repeat(64)}` }],
    [
      "sourceRepository",
      {
        provenance: {
          requestId: "launch-1",
          requestedAt: "2026-07-09T20:00:00.000Z",
          platformRepository: "PittampalliOrg/stacks",
          sourceRepository: "attacker/repo",
        },
      },
    ],
    ["services", { services: ["function-router"] }],
  ])("rejects physical %s drift", async (_field, overrides) => {
    const h = harness(overrides);
    await expect(h.service.authorize(input)).rejects.toMatchObject({
      code: "contract-mismatch",
    });
  });

  it("rejects a non-admin physical owner", async () => {
    const h = harness();
    vi.mocked(h.admins.isPlatformAdmin).mockResolvedValueOnce(false);
    await expect(h.service.authorize(input)).rejects.toMatchObject({
      code: "owner-not-admin",
    });
  });

  it("allows exact reconciled app-live state only for runtime egress", async () => {
    const h = harness({ mode: "reconciled" });
    await expect(h.service.authorize(input)).rejects.toMatchObject({
      code: "contract-mismatch",
    });
    await expect(h.service.authorizeRuntime(input)).resolves.toMatchObject({
      previewName: "preview1",
      requestId: "launch-1",
      owner: "admin-1",
    });
    await expect(
      h.service.authorizeRuntimeTuple({
        previewName: input.previewName,
        environmentRequestId: input.environmentRequestId,
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: input.catalogDigest,
      }),
    ).resolves.toMatchObject({
      services: ["function-router", "workflow-builder"],
    });
  });

  it("applies runtime source policy to an observed record without another read", async () => {
    const h = harness({ mode: "reconciled" });
    const observed = await h.environments.inspect(input.previewName);
    vi.mocked(h.environments.inspect).mockClear();

    await expect(
      h.service.authorizeObservedRuntimeTuple(
        {
          previewName: input.previewName,
          environmentRequestId: input.environmentRequestId,
          environmentPlatformRevision: input.environmentPlatformRevision,
          environmentSourceRevision: input.environmentSourceRevision,
          catalogDigest: input.catalogDigest,
        },
        observed,
      ),
    ).resolves.toMatchObject({
      previewName: input.previewName,
      requestId: input.environmentRequestId,
      services: ["function-router", "workflow-builder"],
    });
    expect(h.environments.inspect).not.toHaveBeenCalled();
  });

  it("does not authorize a reconciled non-app-live runtime", async () => {
    const h = harness({ mode: "reconciled", profile: "manifest-candidate" });
    await expect(h.service.authorizeRuntime(input)).rejects.toMatchObject({
      code: "contract-mismatch",
    });
  });

  it("authorizes exact manifest-candidate traces before readiness without requiring the current catalog", async () => {
    const historicalDigest = `sha256:${"d".repeat(64)}` as const;
    const h = harness({
      ready: false,
      profile: "manifest-candidate",
      mode: "reconciled",
      trustedCode: false,
      catalogDigest: historicalDigest,
      services: ["candidate-only-service"],
    });

    await expect(
      h.service.authorizeTraceTuple({
        previewName: input.previewName,
        environmentRequestId: input.environmentRequestId,
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: historicalDigest,
      }),
    ).resolves.toMatchObject({
      previewName: input.previewName,
      catalogDigest: historicalDigest,
      services: ["candidate-only-service"],
    });
  });

  it("keeps a retained preview readable after the current catalog rotates", async () => {
    const historicalDigest = `sha256:${"d".repeat(64)}` as const;
    const h = harness({ catalogDigest: historicalDigest });
    const historicalIdentity = {
      previewName: input.previewName,
      environmentRequestId: input.environmentRequestId,
      environmentPlatformRevision: input.environmentPlatformRevision,
      environmentSourceRevision: input.environmentSourceRevision,
      catalogDigest: historicalDigest,
    };

    await expect(
      h.service.authorizeRuntimeTuple(historicalIdentity),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    await expect(
      h.service.authorizeReadTuple(historicalIdentity),
    ).resolves.toMatchObject({
      previewName: input.previewName,
      catalogDigest: historicalDigest,
      services: ["function-router", "workflow-builder"],
    });
  });

  it("rejects a read request for a different retained catalog generation", async () => {
    const h = harness();

    await expect(
      h.service.authorizeReadTuple({
        previewName: input.previewName,
        environmentRequestId: input.environmentRequestId,
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: `sha256:${"d".repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it("rejects a trace request for a different immutable generation", async () => {
    const h = harness({
      ready: false,
      profile: "manifest-candidate",
      mode: "reconciled",
      trustedCode: false,
    });

    await expect(
      h.service.authorizeTraceTuple({
        previewName: input.previewName,
        environmentRequestId: "another-launch",
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: input.catalogDigest,
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it("authorizes a one-service runtime tuple without requiring the full catalog", async () => {
    const h = harness({ services: ["workflow-builder"] });
    await expect(
      h.service.authorizeRuntimeTuple({
        previewName: input.previewName,
        environmentRequestId: input.environmentRequestId,
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: input.catalogDigest,
      }),
    ).resolves.toMatchObject({ services: ["workflow-builder"] });
  });

  it("authorizes an acceptance-only service in a reconciled runtime tuple", async () => {
    const h = harness({
      mode: "reconciled",
      services: ["sandbox-execution-api"],
    });
    await expect(
      h.service.authorizeRuntimeTuple({
        previewName: input.previewName,
        environmentRequestId: input.environmentRequestId,
        environmentPlatformRevision: input.environmentPlatformRevision,
        environmentSourceRevision: input.environmentSourceRevision,
        catalogDigest: input.catalogDigest,
      }),
    ).resolves.toMatchObject({ services: ["sandbox-execution-api"] });
  });
});
