import { describe, expect, it, vi } from "vitest";
import {
  ApplicationPreviewDevelopmentBuildService,
  canonicalPreviewOrigin,
} from "$lib/server/application/preview-development-build";
import type {
  DevPreviewAcceptanceCapturePort,
  PreviewDevelopmentBrokerRequest,
  PreviewDevelopmentBuildBrokerPort,
  PreviewEnvironmentProvisioner,
  PreviewEnvironmentVersionedServiceCatalogPort,
  ReplaceDevPreviewImagesParams,
} from "$lib/server/application/ports";

const SOURCE_SHA = "a".repeat(40);
const DIGEST = `sha256:${"d".repeat(64)}` as const;
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;

function dependencies() {
  const capture: DevPreviewAcceptanceCapturePort = {
    captureAcceptanceCandidate: vi.fn(async () => ({
      ok: true,
      artifactId: "artifact-1",
      captureId: "capture-1",
      generation: "generation-1",
      services: [
        { service: "function-router", ok: true },
        { service: "workflow-builder", ok: true },
      ],
    })),
  };
  const broker: PreviewDevelopmentBuildBrokerPort = {
    build: vi.fn(async (input: PreviewDevelopmentBrokerRequest) => ({
      ok: true,
      previewName: input.previewName,
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA as never,
      baselineRevision: "b".repeat(40) as never,
      pullRequestBase: "main",
      changedPaths: ["src/changed.ts"],
      catalogDigest: input.catalogDigest,
      services: input.services.map((service) => ({
        service,
        ok: true as const,
        image: {
          service,
          sourceRevision: SOURCE_SHA as never,
          buildId: `build-${service}`,
          imageRef: `ghcr.io/pittampalliorg/${service}-dev:git-${SOURCE_SHA}`,
          digest: DIGEST,
          immutableRef: `ghcr.io/pittampalliorg/${service}-dev@${DIGEST}`,
        },
      })),
    })),
  };
  const provisioner: PreviewEnvironmentProvisioner = {
		freezeSourcesForTeardown: vi.fn(async (input) => ({
			executionId: input.executionId,
			generation: "generation-1",
			services: input.services.map((service: string) => ({
				service,
				generation: "generation-1",
				contentSha256: `sha256:${"a".repeat(64)}`,
			})),
		})),
    provision: vi.fn(async (input) => ({
      sandboxName: `sandbox-${input.service}`,
      executionId: input.executionId,
      service: input.service ?? "workflow-builder",
      image: input.image ?? "",
      podIP: "10.0.0.2",
      port: 3000,
      syncPort: 8001,
      url: "http://10.0.0.2:3000",
      healthPath: "/",
      syncUrl: "http://10.0.0.2:8001/__sync",
      syncCapability: "test-sync-capability",
      browseUrl: input.origin ?? null,
      repoUrl: "PittampalliOrg/workflow-builder",
      repoSubdir: ".",
      syncPaths: ["src"],
      extraSync: [],
      captureOnly: [],
      ready: true,
      status: "running",
      needsDapr: true,
      daprAppId: input.service ?? null,
    })),
    provisionMany: vi.fn(),
    replaceMany: vi.fn(async (input: ReplaceDevPreviewImagesParams) => ({
      executionId: input.executionId,
      ok: true as const,
      complete: true as const,
      pending: false as const,
      activationPhase: "not-required" as const,
      services: input.services.map(({ service, image }) => ({
        service,
        ok: true,
        info: {
          sandboxName: `sandbox-${service}`,
          executionId: input.executionId,
          service,
          image,
          podIP: "10.0.0.2",
          port: 3000,
          syncPort: 8001,
          url: "http://10.0.0.2:3000",
          healthPath: "/",
          syncUrl: "http://10.0.0.2:8001/__sync",
          syncCapability: "test-sync-capability",
          browseUrl: input.origin ?? null,
          repoUrl: "PittampalliOrg/workflow-builder",
          repoSubdir: ".",
          syncPaths: ["src"],
          extraSync: [],
          captureOnly: [],
          ready: true,
          status: "running",
          needsDapr: true,
          daprAppId: service,
        },
      })),
      rollback: null,
    })),
    freezeSources: vi.fn(),
    releaseSandboxes: vi.fn(),
    teardown: vi.fn(),
  };
  const supported = [
    "function-router",
    "workflow-builder",
    "workflow-mcp-server",
    "workflow-orchestrator",
  ];
  const catalog: PreviewEnvironmentVersionedServiceCatalogPort = {
    currentDigest: () => CATALOG_DIGEST,
    listPreviewNativeServices: () => supported,
    assertPreviewNativeServices: (requested) => {
      if (requested.some((service) => !supported.includes(service))) {
        throw new Error("unsupported preview-native service");
      }
      return [...requested].sort();
    },
  };
  return { capture, broker, provisioner, catalog };
}

function service(overrides: Partial<ReturnType<typeof dependencies>> = {}) {
  const deps = { ...dependencies(), ...overrides };
  return {
    deps,
    service: new ApplicationPreviewDevelopmentBuildService({
      ...deps,
      requestId: () => "request-1",
    }),
  };
}

describe("ApplicationPreviewDevelopmentBuildService", () => {
  it("captures, validates, pushes a branch, builds, then reprovisions exact digests", async () => {
    const { deps, service: app } = service();
    const result = await app.buildAndReprovision({
      executionId: "exec-1",
      services: ["workflow-builder", "function-router"],
      origin: "https://wfb-feature1.tail286401.ts.net",
      adopt: false,
    });

    expect(result).toMatchObject({
      ok: true,
      stage: "complete",
      artifactId: "artifact-1",
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA,
      baselineRevision: "b".repeat(40),
      pullRequestBase: "main",
      changedPaths: ["src/changed.ts"],
      services: [
        {
          service: "function-router",
          build: { ok: true },
          provision: { ok: true },
        },
        {
          service: "workflow-builder",
          build: { ok: true },
          provision: { ok: true },
        },
      ],
      rollback: null,
    });
    expect(deps.capture.captureAcceptanceCandidate).toHaveBeenCalledWith({
      executionId: "exec-1",
      nodeId: "preview-development-build",
      expectedServices: ["function-router", "workflow-builder"],
    });
    expect(deps.broker.build).toHaveBeenCalledWith({
      requestId: "request-1",
      executionId: "exec-1",
      artifactId: "artifact-1",
      previewName: "feature1",
      catalogDigest: CATALOG_DIGEST,
      services: ["function-router", "workflow-builder"],
    });
    expect(deps.provisioner.replaceMany).toHaveBeenCalledOnce();
    expect(deps.provisioner.replaceMany).toHaveBeenCalledWith({
      executionId: "exec-1",
      services: [
        {
          service: "function-router",
          image: `ghcr.io/pittampalliorg/function-router-dev@${DIGEST}`,
        },
        {
          service: "workflow-builder",
          image: `ghcr.io/pittampalliorg/workflow-builder-dev@${DIGEST}`,
        },
      ],
      executionClass: "preview-development-build",
      mode: "preview-native",
      adopt: false,
      origin: "https://wfb-feature1.tail286401.ts.net",
    });
    expect(
      vi.mocked(deps.capture.captureAcceptanceCandidate).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(deps.broker.build).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("preserves partial build truth and provisions no images", async () => {
    const deps = dependencies();
    vi.mocked(deps.broker.build).mockImplementation(async (input) => ({
      ok: false,
      previewName: input.previewName,
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA as never,
      baselineRevision: "b".repeat(40) as never,
      pullRequestBase: "main",
      changedPaths: ["src/changed.ts"],
      catalogDigest: input.catalogDigest,
      services: [
        { service: "function-router", ok: false, error: "build failed" },
        {
          service: "workflow-builder",
          ok: true,
          image: {
            service: "workflow-builder",
            sourceRevision: SOURCE_SHA as never,
            buildId: "build-wfb",
            imageRef: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
            digest: DIGEST,
            immutableRef: `ghcr.io/pittampalliorg/workflow-builder-dev@${DIGEST}`,
          },
        },
      ],
    }));
    const app = new ApplicationPreviewDevelopmentBuildService({
      ...deps,
      requestId: () => "request-1",
    });

    const result = await app.buildAndReprovision({
      executionId: "exec-1",
      services: ["function-router", "workflow-builder"],
      origin: "https://wfb-feature1.tail286401.ts.net",
      adopt: false,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "complete",
      services: [
        {
          service: "function-router",
          build: { ok: false, error: "build failed" },
          provision: { ok: false, skipped: "batch-build-failed" },
        },
        {
          service: "workflow-builder",
          build: { ok: true },
          provision: { ok: false, skipped: "batch-build-failed" },
        },
      ],
    });
    expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
  });

  it("rebuilds and reprovisions only the broker-derived changed-service closure", async () => {
    const deps = dependencies();
    vi.mocked(deps.broker.build).mockImplementation(async (input) => ({
      ok: true,
      previewName: input.previewName,
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA as never,
      baselineRevision: "b".repeat(40) as never,
      pullRequestBase: "main",
      changedPaths: ["services/function-router/src/changed.ts"],
      catalogDigest: input.catalogDigest,
      services: [
        {
          service: "function-router",
          ok: true as const,
          image: {
            service: "function-router",
            sourceRevision: SOURCE_SHA as never,
            buildId: "build-function-router",
            imageRef: `ghcr.io/pittampalliorg/function-router-dev:git-${SOURCE_SHA}`,
            digest: DIGEST,
            immutableRef: `ghcr.io/pittampalliorg/function-router-dev@${DIGEST}`,
          },
        },
      ],
    }));
    const app = new ApplicationPreviewDevelopmentBuildService({
      ...deps,
      requestId: () => "request-1",
    });

    const result = await app.buildAndReprovision({
      executionId: "exec-1",
      services: ["function-router"],
      origin: "https://wfb-feature1.tail286401.ts.net",
      adopt: true,
    });

    expect(result).toMatchObject({
      ok: true,
      services: [{ service: "function-router", provision: { ok: true } }],
    });
    expect(deps.provisioner.replaceMany).toHaveBeenCalledWith(
      expect.objectContaining({
        services: [
          {
            service: "function-router",
            image: `ghcr.io/pittampalliorg/function-router-dev@${DIGEST}`,
          },
        ],
      }),
    );
  });

  it.each([
    ["empty", []],
    [
      "unknown",
      [
        {
          service: "not-requested",
          ok: false as const,
          error: "irrelevant",
        },
      ],
    ],
    [
      "duplicate",
      [
        { service: "function-router", ok: false as const, error: "one" },
        { service: "function-router", ok: false as const, error: "two" },
      ],
    ],
  ] as const)(
    "rejects a %s broker changed-service closure",
    async (_name, results) => {
      const deps = dependencies();
      vi.mocked(deps.broker.build).mockImplementation(async (input) => ({
        ok: false,
        previewName: input.previewName,
        branch: "preview-development-1",
        sourceRevision: SOURCE_SHA as never,
        baselineRevision: "b".repeat(40) as never,
        pullRequestBase: "main",
        changedPaths: ["src/changed.ts"],
        catalogDigest: input.catalogDigest,
        services: [...results],
      }));
      const app = new ApplicationPreviewDevelopmentBuildService({ ...deps });

      await expect(
        app.buildAndReprovision({
          executionId: "exec-1",
          services: ["function-router", "workflow-builder"],
          origin: "https://wfb-feature1.tail286401.ts.net",
          adopt: false,
        }),
      ).resolves.toMatchObject({
        ok: false,
        stage: "broker",
        error: expect.stringContaining("invalid changed-service closure"),
      });
      expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["mutable baseline", { baselineRevision: "main" as never }],
    ["unchanged commit", { baselineRevision: SOURCE_SHA as never }],
    ["different base", { pullRequestBase: "release" }],
    ["empty paths", { changedPaths: [] }],
    ["non-normalized path", { changedPaths: ["../src/changed.ts"] }],
    ["duplicate paths", { changedPaths: ["src/changed.ts", "src/changed.ts"] }],
  ] as const)("rejects broker Git provenance with %s", async (_name, drift) => {
    const deps = dependencies();
    vi.mocked(deps.broker.build).mockImplementation(async (input) => ({
      ok: true,
      previewName: input.previewName,
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA as never,
      baselineRevision: "b".repeat(40) as never,
      pullRequestBase: "main",
      changedPaths: ["src/changed.ts"],
      catalogDigest: input.catalogDigest,
      services: [],
      ...drift,
    }));
    const app = new ApplicationPreviewDevelopmentBuildService({ ...deps });

    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["workflow-builder"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: false,
      }),
    ).resolves.toMatchObject({
      ok: false,
      stage: "broker",
      error: "preview control broker returned mismatched provenance",
    });
    expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
  });

  it("rejects a successful image result from a different candidate revision", async () => {
    const deps = dependencies();
    vi.mocked(deps.broker.build).mockImplementation(async (input) => ({
      ok: true,
      previewName: input.previewName,
      branch: "preview-development-1",
      sourceRevision: SOURCE_SHA as never,
      baselineRevision: "b".repeat(40) as never,
      pullRequestBase: "main",
      changedPaths: ["src/changed.ts"],
      catalogDigest: input.catalogDigest,
      services: [
        {
          service: "workflow-builder",
          ok: true as const,
          image: {
            service: "workflow-builder",
            sourceRevision: "e".repeat(40) as never,
            buildId: "build-wfb",
            imageRef: `ghcr.io/pittampalliorg/workflow-builder-dev:git-${SOURCE_SHA}`,
            digest: DIGEST,
            immutableRef: `ghcr.io/pittampalliorg/workflow-builder-dev@${DIGEST}`,
          },
        },
      ],
    }));
    const app = new ApplicationPreviewDevelopmentBuildService({ ...deps });

    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["workflow-builder"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: false,
      }),
    ).resolves.toMatchObject({
      ok: false,
      stage: "broker",
      error:
        "preview control broker returned invalid development image provenance",
    });
    expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
  });

  it("reports a failed coherent replacement only after rollback", async () => {
    const deps = dependencies();
    vi.mocked(deps.provisioner.replaceMany).mockResolvedValueOnce({
      executionId: "exec-1",
      ok: false,
      complete: false,
      pending: false,
      activationPhase: "failed",
      services: [
        { service: "function-router", ok: false, error: "replacement failed" },
        { service: "workflow-builder", ok: true },
      ],
      rollback: {
        attempted: true,
        ok: true,
        services: [
          { service: "function-router", ok: true },
          { service: "workflow-builder", ok: true },
        ],
      },
    });
    const app = new ApplicationPreviewDevelopmentBuildService({
      ...deps,
    });

    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["function-router", "workflow-builder"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: false,
      }),
    ).resolves.toMatchObject({
      ok: false,
      stage: "complete",
      services: [
        {
          service: "function-router",
          provision: { ok: false, error: "replacement failed" },
        },
        {
          service: "workflow-builder",
          provision: {
            ok: false,
            error: "multi-service replacement failed and was rolled back",
          },
        },
      ],
      rollback: { attempted: true, ok: true },
    });
  });

  it("fails closed before capture for unsupported services and non-preview origins", async () => {
    const { deps, service: app } = service();
    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["swebench-coordinator"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: true,
      }),
    ).rejects.toThrow("unsupported preview-native service");
    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["workflow-builder"],
        origin: "http://workflow-builder.dev.svc.cluster.local:3000/path",
        adopt: true,
      }),
    ).rejects.toThrow("origin must match https://wfb-<preview>");
    expect(deps.capture.captureAcceptanceCandidate).not.toHaveBeenCalled();
  });

  it("rejects adoption of the coordinating workflow-builder BFF before capture", async () => {
    const { deps, service: app } = service();

    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["workflow-builder", "function-router"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: true,
      }),
    ).rejects.toThrow(
      "adopt=true cannot replace the workflow-builder BFF that is coordinating the build",
    );
    expect(deps.capture.captureAcceptanceCandidate).not.toHaveBeenCalled();
    expect(deps.broker.build).not.toHaveBeenCalled();
    expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
  });

  it("does not reprovision when the physical broker rejects the artifact", async () => {
    const deps = dependencies();
    vi.mocked(deps.broker.build).mockRejectedValueOnce(
      new Error("development source artifact was rejected"),
    );
    const app = new ApplicationPreviewDevelopmentBuildService({
      ...deps,
    });
    await expect(
      app.buildAndReprovision({
        executionId: "exec-1",
        services: ["function-router", "workflow-builder"],
        origin: "https://wfb-feature1.tail286401.ts.net",
        adopt: false,
      }),
    ).resolves.toMatchObject({ ok: false, stage: "broker" });
    expect(deps.provisioner.replaceMany).not.toHaveBeenCalled();
  });
});

describe("canonicalPreviewOrigin", () => {
  it("accepts only a pathless Tailnet preview origin", () => {
    expect(
      canonicalPreviewOrigin("https://wfb-preview-1.tail286401.ts.net/"),
    ).toBe("https://wfb-preview-1.tail286401.ts.net");
    for (const invalid of [
      "http://wfb-preview-1.tail286401.ts.net",
      "https://wfb-preview-1.tail286401.ts.net/path",
      "https://user@wfb-preview-1.tail286401.ts.net",
      "https://wfb-preview-1.example.com",
      "https://workflow-builder.dev.svc.cluster.local",
    ]) {
      expect(() => canonicalPreviewOrigin(invalid)).toThrow();
    }
  });
});
