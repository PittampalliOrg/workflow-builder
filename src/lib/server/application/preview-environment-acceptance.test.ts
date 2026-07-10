import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewEnvironmentAcceptanceService,
  PreviewEnvironmentAcceptanceContractError,
} from "$lib/server/application/preview-environment-acceptance";
import type {
  PreviewEnvironment,
  PreviewEnvironmentCleanupProof,
  PreviewEnvironmentLaunchPort,
  PreviewProductionImage,
  ValidatedPreviewEnvironmentLaunchSpec,
} from "$lib/server/application/ports";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;

function input() {
  return {
    name: "acceptance-one",
    platformRevision: PLATFORM_SHA,
    sourceRevision: SOURCE_SHA,
    services: ["workflow-builder", "function-router"],
    owner: { kind: "session" as const, id: "session-1" },
    origin: { kind: "interactive-session" as const, reference: "session-1" },
    ttlHours: 4,
    lifecycle: "ephemeral" as const,
    provenance: {
      requestId: "acceptance-request-1",
      requestedAt: "2026-07-09T20:00:00Z",
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
      parentEnvironmentId: "app-live-one",
    },
  };
}

function cleanupProof(
  overrides: Partial<PreviewEnvironmentCleanupProof> = {},
): PreviewEnvironmentCleanupProof {
  return {
    name: "acceptance-one",
    resourceName: "acceptance-one",
    complete: true,
    phase: "complete",
    checks: {
      "runner-succeeded": true,
      "preview-environment-absent": true,
      "application-absent": true,
      "agent-registration-absent": true,
      "agent-namespaces-absent": true,
      "database-absent": true,
      "nats-stream-absent": true,
      "headlamp-registration-absent": true,
      "tailnet-egress-absent": true,
      "host-namespace-absent": true,
      "storage-scope-absent": true,
      "runner-identity-absent": true,
    },
    message: null,
    ...overrides,
  };
}

function built(service: string, digestChar: string): PreviewProductionImage {
  const digest = `sha256:${digestChar.repeat(64)}` as const;
  return {
    service,
    sourceRevision: SOURCE_SHA as never,
    buildId: `build-${service}`,
    imageRef: `ghcr.io/pittampalliorg/${service}:git-${SOURCE_SHA}`,
    digest,
    immutableRef: `ghcr.io/pittampalliorg/${service}@${digest}`,
  };
}

function environment(
  command: ValidatedPreviewEnvironmentLaunchSpec,
): PreviewEnvironment {
  return {
    ...command,
    id: command.name,
    lifecycleState: "provisioning",
    createdAt: "2026-07-09T20:01:00Z",
    expiresAt: "2026-07-10T00:01:00Z",
    runtime: {
      placement: "dev-vcluster",
      phase: "provisioning",
      ready: false,
      url: null,
      allocationId: null,
      pooled: false,
    },
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const launch: PreviewEnvironmentLaunchPort = {
    launch: vi.fn(async (command) => ({
      ok: true as const,
      environment: environment(command),
    })),
  };
  return {
    catalog: {
      currentDigest: vi.fn(() => CATALOG_DIGEST),
      listPreviewNativeServices: vi.fn(() => ["workflow-builder"]),
      assertPreviewNativeServices: vi.fn((services: readonly string[]) => [
        ...services,
      ]),
      assertAcceptanceReplayServices: vi.fn((services: readonly string[]) => [
        ...services,
      ]),
    },
    inventory: {
      inspect: vi.fn(async () => ({ exists: false, phase: "absent" })),
    },
    images: {
      build: vi.fn(async () => [
        built("workflow-builder", "c"),
        built("function-router", "d"),
      ]),
    },
    launch,
    readiness: {
      waitReady: vi.fn(async () => ({
        ready: true,
        phase: "ready",
        url: "https://wfb-acceptance-one.example.test",
      })),
    },
    runtime: {
      waitForImages: vi.fn(
        async ({ images }: { images: Readonly<Record<string, string>> }) => ({
          ok: true,
          checks: Object.entries(images).map(([service, expectedImage]) => ({
            service,
            ok: true,
            expectedImage,
            observedImages: [expectedImage],
          })),
        }),
      ),
    },
    verification: {
      verify: vi.fn(async () => ({
        ok: true,
        checks: [{ name: "full-system", ok: true }],
      })),
    },
    teardown: { teardown: vi.fn(async () => cleanupProof()) },
    ...overrides,
  };
}

describe("ApplicationPreviewEnvironmentAcceptanceService", () => {
  it("builds only requested services and verifies a fresh reconciled digest replay", async () => {
    const deps = dependencies();
    const service = new ApplicationPreviewEnvironmentAcceptanceService(deps);

    const result = await service.replay(input());

    expect(result).toMatchObject({
      ok: true,
      retained: false,
      cleanup: { complete: true, phase: "complete" },
      environment: {
        profile: "app-live",
        mode: "reconciled",
        allocation: { kind: "cold" },
        lifecycleState: "ready",
        runtime: { ready: true, phase: "ready" },
      },
      verification: { ok: true },
    });
    expect(deps.teardown.teardown).toHaveBeenCalledWith({
      name: "acceptance-one",
      timeoutMs: 900_000,
      guard: {
        mode: "owned",
        requestId: "acceptance-request-1",
        sourceRevision: SOURCE_SHA,
      },
    });
    expect(deps.images.build).toHaveBeenCalledWith({
      requestId: "acceptance-request-1",
      sourceRepository: "PittampalliOrg/workflow-builder",
      sourceRevision: SOURCE_SHA,
      services: ["workflow-builder", "function-router"],
    });
    expect(deps.launch.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: ["immutable-image-replay"],
        imageOverrides: {
          "workflow-builder": expect.stringContaining("@sha256:"),
          "function-router": expect.stringContaining("@sha256:"),
        },
      }),
    );
    expect(deps.readiness.waitReady).toHaveBeenCalledWith(
      expect.objectContaining({
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
        profile: "app-live",
        lane: "application",
        mode: "reconciled",
        services: ["workflow-builder", "function-router"],
        owner: { kind: "session", id: "session-1" },
        origin: { kind: "interactive-session", reference: "session-1" },
        lifecycle: "ephemeral",
        provenance: input().provenance,
        catalogDigest: CATALOG_DIGEST,
        allocation: { kind: "cold" },
        images: {
          "workflow-builder": expect.stringContaining("@sha256:"),
          "function-router": expect.stringContaining("@sha256:"),
        },
      }),
    );
  });

  it("rejects an existing name before images are built or launch is attempted", async () => {
    const deps = dependencies({
      inventory: {
        inspect: vi.fn(async () => ({ exists: true, phase: "Ready" })),
      },
    });

    await expect(
      new ApplicationPreviewEnvironmentAcceptanceService(deps).replay(input()),
    ).resolves.toMatchObject({
      ok: false,
      stage: "freshness",
      message: expect.stringContaining("already exists"),
    });
    expect(deps.images.build).not.toHaveBeenCalled();
    expect(deps.launch.launch).not.toHaveBeenCalled();
  });

  it("reports cleanup failure after verification instead of claiming success", async () => {
    const deps = dependencies({
      teardown: {
        teardown: vi.fn(async () => {
          throw new Error("delete timed out");
        }),
      },
    });
    const service = new ApplicationPreviewEnvironmentAcceptanceService(deps);

    await expect(service.replay(input())).resolves.toMatchObject({
      ok: false,
      stage: "cleanup",
      message: expect.stringContaining("delete timed out"),
      verification: { ok: true },
    });
  });

  it("reports incomplete cleanup proof instead of claiming success", async () => {
    const deps = dependencies({
      teardown: {
        teardown: vi.fn(async () =>
          cleanupProof({
            complete: false,
            phase: "timeout",
            message: "Application still exists",
          }),
        ),
      },
    });

    await expect(
      new ApplicationPreviewEnvironmentAcceptanceService(deps).replay(input()),
    ).resolves.toMatchObject({
      ok: false,
      stage: "cleanup",
      cleanup: { complete: false, phase: "timeout" },
      message: "Application still exists",
    });
  });

  it("fails closed when the selective builder omits a service", async () => {
    const deps = dependencies({
      images: { build: vi.fn(async () => [built("workflow-builder", "c")]) },
    });
    const service = new ApplicationPreviewEnvironmentAcceptanceService(deps);
    await expect(service.replay(input())).rejects.toThrow(
      PreviewEnvironmentAcceptanceContractError,
    );
    expect(deps.launch.launch).not.toHaveBeenCalled();
  });

  it("returns a typed build failure without launching", async () => {
    const deps = dependencies({
      images: {
        build: vi.fn(async () => {
          throw new Error("build queue unavailable");
        }),
      },
    });
    const result = await new ApplicationPreviewEnvironmentAcceptanceService(
      deps,
    ).replay(input());
    expect(result).toMatchObject({
      ok: false,
      stage: "build",
      message: expect.stringContaining("build queue unavailable"),
    });
    expect(deps.launch.launch).not.toHaveBeenCalled();
  });

  it("returns capacity without waiting or verifying", async () => {
    const deps = dependencies({
      launch: {
        launch: vi.fn(async () => ({
          ok: false as const,
          reason: "capacity" as const,
          awake: 6,
          max: 6,
          message: "full",
        })),
      },
    });
    const result = await new ApplicationPreviewEnvironmentAcceptanceService(
      deps,
    ).replay(input());
    expect(result).toMatchObject({ ok: false, stage: "capacity" });
    expect(deps.readiness.waitReady).not.toHaveBeenCalled();
    expect(deps.verification.verify).not.toHaveBeenCalled();
  });

  it("cleans a non-ready environment and skips verification", async () => {
    const deps = dependencies({
      readiness: {
        waitReady: vi.fn(async () => ({
          ready: false,
          phase: "degraded",
          url: null,
        })),
      },
    });
    const result = await new ApplicationPreviewEnvironmentAcceptanceService(
      deps,
    ).replay(input());
    expect(result).toMatchObject({
      ok: false,
      stage: "readiness",
      environment: { lifecycleState: "failed" },
    });
    expect(deps.verification.verify).not.toHaveBeenCalled();
    expect(deps.teardown.teardown).toHaveBeenCalledOnce();
  });

  it("stops before product verification when runtime digests do not match", async () => {
    const deps = dependencies({
      runtime: {
        waitForImages: vi.fn(
          async ({ images }: { images: Readonly<Record<string, string>> }) => ({
            ok: false,
            checks: Object.entries(images).map(
              ([service, expectedImage], index) => ({
                service,
                ok: index !== 0,
                expectedImage,
                observedImages:
                  index === 0
                    ? ["ghcr.io/pittampalliorg/workflow-builder@sha256:bad"]
                    : [expectedImage],
              }),
            ),
          }),
        ),
      },
    });

    await expect(
      new ApplicationPreviewEnvironmentAcceptanceService(deps).replay(input()),
    ).resolves.toMatchObject({
      ok: false,
      stage: "runtime",
      verification: { ok: false },
    });
    expect(deps.verification.verify).not.toHaveBeenCalled();
    expect(deps.teardown.teardown).toHaveBeenCalledOnce();
  });

  it("surfaces verification failures and delegates explicit teardown", async () => {
    const deps = dependencies({
      verification: {
        verify: vi.fn(async () => ({
          ok: false,
          checks: [{ name: "full-system", ok: false, detail: "HTTP 500" }],
        })),
      },
    });
    const service = new ApplicationPreviewEnvironmentAcceptanceService(deps);
    const result = await service.replay(input());
    expect(result).toMatchObject({
      ok: false,
      stage: "verification",
      verification: { ok: false },
    });
    const guard = {
      mode: "owned" as const,
      requestId: "acceptance-request-1",
      sourceRevision: SOURCE_SHA,
    };
    await service.teardown("acceptance-one", guard as never);
    expect(deps.teardown.teardown).toHaveBeenCalledWith({
      name: "acceptance-one",
      timeoutMs: 900_000,
      guard,
    });
  });
});
