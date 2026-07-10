import { describe, expect, it, vi } from "vitest";
import {
  GithubPreviewEnvironmentRevisionResolver,
  SeaVclusterPreviewEnvironmentLaunchAdapter,
  OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter,
} from "$lib/server/application/adapters/preview-environments";
import { DevPreviewServiceCatalogAdapter } from "$lib/server/application/adapters/dev-preview-service-catalog";
import { validatePreviewEnvironmentLaunchSpec as validateLaunchSpec } from "$lib/server/application/preview-environments";
import type {
  PreviewEnvironmentLaunchSpec,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import type {
  VclusterPreviewCounts,
  VclusterPreviewRecord,
} from "$lib/types/dev-previews";

const PLATFORM_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const CATALOG_DIGEST = `sha256:${"c".repeat(64)}` as const;

function validatePreviewEnvironmentLaunchSpec(
  input: PreviewEnvironmentLaunchSpec,
) {
  return validateLaunchSpec(input, CATALOG_DIGEST);
}

describe("DevPreviewServiceCatalogAdapter", () => {
  it("canonicalizes preview-native services and rejects host-only or unknown entries", () => {
    const catalog = new DevPreviewServiceCatalogAdapter();
    expect(catalog.currentDigest()).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(catalog.listPreviewNativeServices()).toEqual([
      "function-router",
      "mcp-gateway",
      "workflow-builder",
      "workflow-mcp-server",
      "workflow-orchestrator",
    ]);
    expect(
      catalog.assertPreviewNativeServices([
        "workflow-orchestrator",
        "workflow-builder",
        "workflow-builder",
      ]),
    ).toEqual(["workflow-builder", "workflow-orchestrator"]);
    expect(() =>
      catalog.assertPreviewNativeServices([
        "swebench-coordinator",
        "not-registered",
      ]),
    ).toThrow(
      /not-registered is not registered.*swebench-coordinator is host-throwaway only/,
    );
  });

  it("expands shared workflow-data contract paths through catalog source ownership", () => {
    const catalog = new DevPreviewServiceCatalogAdapter();
    expect(
      catalog.deriveChangedServices([
        "services/shared/workflow-data-contract/schema.json",
      ]),
    ).toEqual({
      services: ["workflow-builder", "workflow-orchestrator"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
  });

  it("admits SEA for immutable replay without exposing it as a hot-sync service", () => {
    const catalog = new DevPreviewServiceCatalogAdapter();
    expect(catalog.listPreviewNativeServices()).not.toContain(
      "sandbox-execution-api",
    );
    expect(
      catalog.assertAcceptanceReplayServices([
        "sandbox-execution-api",
        "workflow-builder",
      ]),
    ).toEqual(["sandbox-execution-api", "workflow-builder"]);
    expect(
      catalog.deriveChangedServices([
        "services/sandbox-execution-api/src/app.py",
      ]),
    ).toEqual({
      services: ["sandbox-execution-api"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
    expect(
      catalog.deriveChangedServices(["services/dev-sync-sidecar/server.mjs"]),
    ).toEqual({
      services: [],
      activationArtifacts: ["dev-sync-sidecar"],
      unmappedRuntimePaths: [],
    });
    expect(
      catalog.deriveChangedServices(["services/mcp-gateway/src/index.ts"]),
    ).toEqual({
      services: ["mcp-gateway"],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
    expect(catalog.deriveChangedServices(["docs/preview.md"])).toEqual({
      services: [],
      activationArtifacts: [],
      unmappedRuntimePaths: [],
    });
    expect(
      catalog.deriveChangedServices([
        "src/routes/new.ts",
        ".github/workflows/exfiltrate-app-key.yml",
      ]),
    ).toEqual({
      services: ["workflow-builder"],
      activationArtifacts: [],
      unmappedRuntimePaths: [".github/workflows/exfiltrate-app-key.yml"],
    });
    expect(catalog.deriveChangedServices(["future-build-config.toml"])).toEqual(
      {
        services: [],
        activationArtifacts: [],
        unmappedRuntimePaths: ["future-build-config.toml"],
      },
    );
    expect(
      catalog.deriveGateRequirements([
        "services/sandbox-execution-api/src/app.py",
        "services/dev-sync-sidecar/server.mjs",
      ]),
    ).toEqual({
      catalogDigest: catalog.currentDigest(),
      contexts: ["preview/immutable-acceptance", "preview/activation-images"],
      subjects: {
        "preview/immutable-acceptance": ["sandbox-execution-api"],
        "preview/activation-images": ["dev-sync-sidecar"],
      },
      requirementDigests: {
        "preview/immutable-acceptance": expect.stringMatching(/^sha256:/),
        "preview/activation-images": expect.stringMatching(/^sha256:/),
      },
      unmappedRuntimePaths: [],
    });
  });
});

function spec(
  overrides: Partial<PreviewEnvironmentLaunchSpec> = {},
): PreviewEnvironmentLaunchSpec {
  return {
    name: "feature-x",
    profile: "app-live",
    lane: "application",
    capabilities: ["service-live-sync"],
    platformRevision: PLATFORM_SHA,
    sourceRevision: SOURCE_SHA,
    services: ["workflow-builder", "workflow-orchestrator"],
    owner: { kind: "user", id: "user-42" },
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
    ...overrides,
  };
}

function record(
  overrides: Partial<VclusterPreviewRecord> = {},
): VclusterPreviewRecord {
  return {
    name: "feature-x",
    phase: "provisioning",
    ready: false,
    url: "https://wfb-feature-x.example.test",
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "retained",
    origin: { kind: "user" },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: "2026-07-10T18:00:00.000Z",
    lastActive: null,
    protected: false,
    bootSeconds: 1,
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
    ...overrides,
  };
}

function counts(
  overrides: Partial<VclusterPreviewCounts> = {},
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
    ...overrides,
  };
}

function gateway(
  overrides: Partial<VclusterPreviewGatewayPort> = {},
): VclusterPreviewGatewayPort {
  return {
    listWithCounts: vi.fn(async () => ({ previews: [], counts: counts() })),
    get: vi.fn(async (name) => record({ name })),
    provision: vi.fn(async (input) => record({ name: input.name })),
    teardown: vi.fn(async (name) => record({ name })),
    runtime: vi.fn(async (name) => ({
      name,
      resourceName: name,
      reconciliationSucceeded: true,
      services: [],
    })),
    cleanup: vi.fn(async (name) => ({
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
    touch: vi.fn(async (name) => ({
      name,
      state: "hot",
      resuming: false,
      lastActive: null,
    })),
    sleep: vi.fn(async (name) => ({
      ok: true as const,
      name,
      alreadySlept: false,
    })),
    ...overrides,
  };
}

describe("GithubPreviewEnvironmentRevisionResolver", () => {
  it("resolves an encoded symbolic ref to a full lowercase SHA", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ sha: PLATFORM_SHA.toUpperCase() }), {
          status: 200,
        }),
    );
    const resolver = new GithubPreviewEnvironmentRevisionResolver({
      fetch,
      token: () => "secret-token",
    });

    await expect(
      resolver.resolve({
        repository: "PittampalliOrg/stacks",
        ref: "refs/pull/42/merge",
      }),
    ).resolves.toBe(PLATFORM_SHA);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/PittampalliOrg/stacks/commits/refs%2Fpull%2F42%2Fmerge",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret-token",
          "X-GitHub-Api-Version": "2022-11-28",
        }),
      }),
    );
  });

  it("rejects invalid repositories, missing refs, API failures, and malformed SHAs", async () => {
    const resolver = new GithubPreviewEnvironmentRevisionResolver({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "not found" }), {
            status: 404,
          }),
      ),
      token: () => null,
    });
    await expect(
      resolver.resolve({ repository: "not-a-slug", ref: "main" }),
    ).rejects.toThrow("Invalid GitHub repository");
    await expect(
      resolver.resolve({ repository: "o/r", ref: "" }),
    ).rejects.toThrow("Git ref is required");
    await expect(
      resolver.resolve({ repository: "o/r", ref: "missing" }),
    ).rejects.toThrow("not found");

    const malformed = new GithubPreviewEnvironmentRevisionResolver({
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ sha: "short" }), { status: 200 }),
      ),
    });
    await expect(
      malformed.resolve({ repository: "o/r", ref: "main" }),
    ).rejects.toThrow("invalid commit SHA");
  });
});

describe("SeaVclusterPreviewEnvironmentLaunchAdapter", () => {
  it("cold-provisions app-live and forwards the trusted contract", async () => {
    const gw = gateway();
    const adapter = new SeaVclusterPreviewEnvironmentLaunchAdapter({
      gateway: gw,
      maxPreviews: 6,
    });
    const outcome = await adapter.launch(
      validatePreviewEnvironmentLaunchSpec(spec()),
    );

    expect(gw.provision).toHaveBeenCalledWith({
      name: "feature-x",
      user: "user-42",
      lifecycle: "retained",
      origin: { kind: "user" },
      ttlHours: 24,
      platformRevision: PLATFORM_SHA,
      sourceRevision: SOURCE_SHA,
      catalogDigest: CATALOG_DIGEST,
      candidatePaths: [],
      delivery: "reconciler",
      enrollMode: "agent",
      profile: "app-live",
      lane: "application",
      mode: "live",
      allocation: { kind: "cold" },
      imageOverrides: {},
      owner: { kind: "user", id: "user-42" },
      services: ["workflow-builder", "workflow-orchestrator"],
      provenance: spec().provenance,
      trustedCode: true,
      createOnly: true,
    });
    expect(outcome).toMatchObject({
      ok: true,
      environment: {
        allocation: { kind: "cold" },
        runtime: { pooled: false, allocationId: null },
      },
    });
  });

  it("capacity-gates a cold provision", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [],
        counts: counts({ awake: 2, max: 6 }),
      })),
    });
    const adapter = new SeaVclusterPreviewEnvironmentLaunchAdapter({
      gateway: gw,
      maxPreviews: 6,
    });
    const outcome = await adapter.launch(
      validatePreviewEnvironmentLaunchSpec(spec()),
    );
    expect(gw.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        platformRevision: PLATFORM_SHA,
        sourceRevision: SOURCE_SHA,
        delivery: "reconciler",
        enrollMode: "agent",
        mode: "live",
        allocation: { kind: "cold" },
        imageOverrides: {},
        trustedCode: true,
        createOnly: true,
      }),
    );
    expect(outcome).toMatchObject({
      ok: true,
      environment: {
        allocation: { kind: "cold" },
        runtime: { pooled: false },
      },
    });
  });

  it("cold-provisions manifest candidates", async () => {
    const gw = gateway();
    const adapter = new SeaVclusterPreviewEnvironmentLaunchAdapter({
      gateway: gw,
      maxPreviews: 6,
    });
    await adapter.launch(
      validatePreviewEnvironmentLaunchSpec(
        spec({
          profile: "manifest-candidate",
          capabilities: ["namespaced-manifests"],
          services: [],
          candidatePaths: [
            "packages/components/workloads/workflow-builder/manifests/deployment.yaml",
          ],
          mode: "reconciled",
          lifecycle: "ephemeral",
          allocation: { kind: "cold" },
        }),
      ),
    );
    expect(gw.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "manifest-candidate",
        createOnly: true,
      }),
    );
  });

  it("rejects an existing create-only reconciled environment", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [record({ name: "feature-x", phase: "ready" })],
        counts: counts({ awake: 1, total: 1 }),
      })),
    });
    const adapter = new SeaVclusterPreviewEnvironmentLaunchAdapter({
      gateway: gw,
      maxPreviews: 6,
    });

    await expect(
      adapter.launch(
        validatePreviewEnvironmentLaunchSpec(
          spec({
            profile: "app-live",
            capabilities: ["immutable-image-replay"],
            services: ["workflow-builder"],
            mode: "reconciled",
            lifecycle: "ephemeral",
            allocation: { kind: "cold" },
            imageOverrides: {
              "workflow-builder": `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`,
            },
          }),
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      reason: "conflict",
      message: expect.stringContaining("create-only"),
    });
    expect(gw.provision).not.toHaveBeenCalled();
  });

  it("returns capacity refusal as data", async () => {
    const gw = gateway({
      listWithCounts: vi.fn(async () => ({
        previews: [],
        counts: counts({ awake: 6, max: 6 }),
      })),
    });
    const adapter = new SeaVclusterPreviewEnvironmentLaunchAdapter({
      gateway: gw,
      maxPreviews: 6,
    });
    await expect(
      adapter.launch(
        validatePreviewEnvironmentLaunchSpec(
          spec({ allocation: { kind: "cold" } }),
        ),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "capacity",
      awake: 6,
      max: 6,
      message:
        "Preview capacity reached (6/6). Tear one down or sleep one first.",
    });
    expect(gw.provision).not.toHaveBeenCalled();
  });
});

describe("OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter", () => {
  it("keeps cloud and Talos credentials outside the BFF", async () => {
    const adapter =
      new OperatorManagedInfrastructurePreviewEnvironmentLaunchAdapter();
    await expect(
      adapter.launch(
        validatePreviewEnvironmentLaunchSpec(
          spec({
            profile: "host-candidate",
            capabilities: ["host-control-plane"],
            services: [],
            mode: "reconciled",
            lifecycle: "exclusive",
            allocation: { kind: "cold" },
          }),
        ),
      ),
    ).rejects.toThrow(
      "host-candidate requires the operator-controlled preview-host-candidate.sh lane",
    );
  });
});
