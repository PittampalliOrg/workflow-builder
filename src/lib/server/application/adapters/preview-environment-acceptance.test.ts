import { describe, expect, it, vi } from "vitest";
import {
  HttpPreviewEnvironmentVerifier,
  TektonPreviewEnvironmentImageBuildAdapter,
  VclusterPreviewInventoryAdapter,
  VclusterPreviewReadinessAdapter,
  VclusterPreviewRuntimeInspectionAdapter,
  VclusterPreviewTeardownAdapter,
} from "$lib/server/application/adapters/preview-environment-acceptance";
import { DevPreviewServiceCatalogAdapter } from "$lib/server/application/adapters/dev-preview-service-catalog";
import { DEV_PREVIEW_CATALOG_DIGEST } from "$lib/server/workflows/dev-preview-registry";
import type {
  PreviewEnvironment,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";

const SOURCE_SHA = "b".repeat(40);
const EXPECTED_PROVENANCE = Object.freeze({
  requestId: "request-1",
  requestedAt: "2026-07-09T20:00:00Z",
  platformRepository: "PittampalliOrg/stacks",
  sourceRepository: "PittampalliOrg/workflow-builder",
});
const EXPECTED_IMAGE = `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`;
const ACCEPTANCE_API_BASE =
  "http://workflow-builder-x-workflow-builder-x-acceptance-one.vcluster-acceptance-one.svc.cluster.local:3000";

function readinessInput() {
  return {
    name: "acceptance-one",
    platformRevision: "a".repeat(40) as never,
    sourceRevision: SOURCE_SHA as never,
    profile: "app-live" as const,
    lane: "application" as const,
    mode: "reconciled" as const,
    services: ["workflow-builder"],
    owner: { kind: "session" as const, id: "session-1" },
    origin: {
      kind: "interactive-session" as const,
      reference: "session-1",
    },
    lifecycle: "ephemeral" as const,
    allocation: { kind: "cold" as const },
    provenance: EXPECTED_PROVENANCE,
    images: { "workflow-builder": EXPECTED_IMAGE },
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
    timeoutMs: 100,
  };
}

function gateway(overrides: Partial<VclusterPreviewGatewayPort> = {}) {
  return {
    listWithCounts: vi.fn(),
    get: vi.fn(),
    provision: vi.fn(),
    teardown: vi.fn(),
    runtime: vi.fn(),
    cleanup: vi.fn(),
    touch: vi.fn(),
    sleep: vi.fn(),
    ...overrides,
  } as VclusterPreviewGatewayPort;
}

function record(
  ready: boolean,
  phase: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: "acceptance-one",
    phase,
    ready,
    url: ready ? "https://acceptance.example.test" : null,
    targetCluster: "dev",
    pool: null,
    state: "hot" as const,
    lifecycle: "ephemeral" as const,
    origin: { kind: "interactive-session" as const, reference: "session-1" },
    legacyOrigin: "user" as const,
    prNumber: null,
    expiresAt: null,
    lastActive: null,
    protected: false,
    bootSeconds: null,
    platformRevision: "a".repeat(40),
    sourceRevision: SOURCE_SHA,
    profile: "app-live" as const,
    lane: "application" as const,
    mode: "reconciled" as const,
    owner: { kind: "session" as const, id: "session-1" },
    services: ["workflow-builder"],
    candidatePaths: [],
    provenance: {
      ...EXPECTED_PROVENANCE,
    },
    trustedCode: true,
    allocation: { kind: "cold" as const },
    images: {
      "workflow-builder": EXPECTED_IMAGE,
    },
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
    ...overrides,
  };
}

function environment(url: string | null): PreviewEnvironment {
  return {
    name: "acceptance-one",
    id: "acceptance-one",
    profile: "app-live",
    lane: "application",
    capabilities: ["immutable-image-replay"],
    placement: "dev-vcluster",
    platformRevision: "a".repeat(40) as never,
    sourceRevision: "b".repeat(40) as never,
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
    services: ["workflow-builder"],
    candidatePaths: [],
    owner: { kind: "session", id: "session-1" },
    origin: { kind: "interactive-session", reference: "session-1" },
    ttlHours: 4,
    mode: "reconciled",
    imageOverrides: {
      "workflow-builder": `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`,
    },
    lifecycle: "ephemeral",
    allocation: { kind: "cold" },
    provenance: {
      requestId: "request-1",
      requestedAt: "2026-07-09T20:00:00Z",
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
    },
    lifecycleState: "ready",
    createdAt: "2026-07-09T20:01:00Z",
    expiresAt: "2026-07-10T00:01:00Z",
    runtime: {
      placement: "dev-vcluster",
      phase: "ready",
      ready: true,
      url,
      allocationId: null,
      pooled: false,
    },
  };
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("preview acceptance infrastructure adapters", () => {
  it("separates hot-sync admission from immutable replay admission", () => {
    const catalog = new DevPreviewServiceCatalogAdapter();
    expect(
      catalog.assertPreviewNativeServices([
        "workflow-orchestrator",
        "workflow-builder",
      ]),
    ).toEqual(["workflow-builder", "workflow-orchestrator"]);
    expect(catalog.assertPreviewNativeServices(["mcp-gateway"])).toEqual([
      "mcp-gateway",
    ]);
    expect(() =>
      catalog.assertPreviewNativeServices(["swebench-coordinator"]),
    ).toThrow("unsupported preview-native services");
    expect(
      catalog.assertAcceptanceReplayServices([
        "sandbox-execution-api",
        "mcp-gateway",
      ]),
    ).toEqual(["mcp-gateway", "sandbox-execution-api"]);
  });

  it("derives selective production PipelineRuns from the canonical catalog", async () => {
    const created: Array<Record<string, unknown>> = [];
    const digest = `sha256:${"d".repeat(64)}`;
    const client = {
      create: vi.fn(async (_namespace, body, _options?: unknown) => {
        created.push(body as Record<string, unknown>);
        return {
          created: true,
          pipelineRun: {
            ...body,
            metadata: { ...body.metadata, uid: "acceptance-run-uid" },
          },
        };
      }),
      get: vi.fn(async (_namespace, name, _options?: unknown) => {
        const service = name.includes("sandbox-execution-api")
          ? "sandbox-execution-api"
          : "workflow-builder";
        return {
          metadata: {
            name,
            namespace: "tekton-pipelines",
            uid: "acceptance-run-uid",
          },
          status: {
            conditions: [{ type: "Succeeded", status: "True" }],
            results: [
              {
                name: "image_ref",
                value: `ghcr.io/pittampalliorg/${service}:git-${SOURCE_SHA}`,
              },
              { name: "image_digest", value: digest },
            ],
          },
        };
      }),
      listTasks: vi.fn(
        async (_namespace, _pipelineRunName, _options?: unknown) => [],
      ),
    };
    const adapter = new TektonPreviewEnvironmentImageBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.build({
        requestId: "request-1",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        services: ["sandbox-execution-api", "workflow-builder"],
      }),
    ).resolves.toEqual([
      {
        service: "sandbox-execution-api",
        sourceRevision: SOURCE_SHA,
        buildId: expect.stringMatching(
          /^preview-accept-sandbox-execution-api-/,
        ),
        imageRef: `ghcr.io/pittampalliorg/sandbox-execution-api:git-${SOURCE_SHA}`,
        digest,
        immutableRef: `ghcr.io/pittampalliorg/sandbox-execution-api@${digest}`,
      },
      {
        service: "workflow-builder",
        sourceRevision: SOURCE_SHA,
        buildId: expect.stringMatching(/^preview-accept-workflow-builder-/),
        imageRef: `ghcr.io/pittampalliorg/workflow-builder:git-${SOURCE_SHA}`,
        digest,
        immutableRef: `ghcr.io/pittampalliorg/workflow-builder@${digest}`,
      },
    ]);
    const manifest = created.find(
      (entry) =>
        (entry.metadata as { labels?: Record<string, string> }).labels?.[
          "stacks.io/image-name"
        ] === "workflow-builder",
    ) as {
      metadata: { annotations: Record<string, string> };
      spec: {
        params: Array<{ name: string; value: string }>;
        timeouts: { pipeline: string };
        taskRunTemplate: {
          serviceAccountName: string;
          podTemplate: { hostUsers: boolean };
        };
      };
    };
    expect(manifest.metadata.annotations).toMatchObject({
      "preview.stacks.io/request-id": "request-1",
      "preview.stacks.io/catalog-digest": expect.stringMatching(/^sha256:/),
    });
    expect(manifest.spec.params).toEqual(
      expect.arrayContaining([
        { name: "source_revision", value: SOURCE_SHA },
        { name: "dockerfile", value: "Dockerfile" },
        { name: "context", value: "." },
      ]),
    );
    const sandboxManifest = created.find(
      (entry) =>
        (entry.metadata as { labels?: Record<string, string> }).labels?.[
          "stacks.io/image-name"
        ] === "sandbox-execution-api",
    ) as typeof manifest;
    expect(sandboxManifest.spec.params).toEqual(
      expect.arrayContaining([
        { name: "image_name", value: "sandbox-execution-api" },
        {
          name: "dockerfile",
          value: "services/sandbox-execution-api/Dockerfile",
        },
        { name: "context", value: "services/sandbox-execution-api" },
      ]),
    );
    expect(manifest.spec.params.some((param) => param.name === "git_url")).toBe(
      false,
    );
    expect(manifest.spec.taskRunTemplate.serviceAccountName).toBe(
      "preview-acceptance-build-executor",
    );
    expect(manifest.spec.taskRunTemplate.podTemplate.hostUsers).toBe(false);
    expect(manifest.spec.timeouts).toEqual({ pipeline: "1h0m0s" });
    expect(client.create.mock.calls[0]?.[2]).toEqual({
      targetCluster: "hub-preview-acceptance",
    });
    expect(client.get.mock.calls[0]?.[2]).toEqual({
      targetCluster: "hub-preview-acceptance",
    });
    expect(client.listTasks.mock.calls[0]?.[2]).toEqual({
      targetCluster: "hub-preview-acceptance",
    });
  });

  it("rejects unsupported services and non-digest build results", async () => {
    const adapter = new TektonPreviewEnvironmentImageBuildAdapter({
      client: {
        create: vi.fn(async (_namespace, body) => ({
          created: true,
          pipelineRun: {
            ...body,
            metadata: { ...body.metadata, uid: "acceptance-run-uid" },
          },
        })),
        get: vi.fn(async (_namespace, name) => ({
          metadata: {
            name,
            namespace: "tekton-pipelines",
            uid: "acceptance-run-uid",
          },
          status: {
            conditions: [{ type: "Succeeded", status: "True" }],
            results: [
              {
                name: "image_ref",
                value: `ghcr.io/pittampalliorg/workflow-builder:git-${SOURCE_SHA}`,
              },
              { name: "image_digest", value: "unknown" },
            ],
          },
        })),
        listTasks: vi.fn(async () => []),
      } as never,
      sleep: vi.fn(async () => undefined),
    });
    await expect(
      adapter.build({
        requestId: "request-1",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        services: ["swebench-coordinator"],
      }),
    ).rejects.toThrow("unsupported preview-native");
    await expect(
      adapter.build({
        requestId: "request-1",
        sourceRepository: "PittampalliOrg/workflow-builder",
        sourceRevision: SOURCE_SHA as never,
        services: ["workflow-builder"],
      }),
    ).rejects.toThrow("no immutable digest");
  });

  it("polls the vcluster gateway until ready", async () => {
    const api = gateway({
      get: vi
        .fn()
        .mockResolvedValueOnce(record(false, "provisioning"))
        .mockResolvedValueOnce(record(true, "ready")),
    });
    const adapter = new VclusterPreviewReadinessAdapter(
      api,
      vi.fn(async () => undefined),
      1,
    );
    await expect(adapter.waitReady(readinessInput())).resolves.toEqual({
      ready: true,
      phase: "ready",
      url: "https://acceptance.example.test",
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it("fails readiness when a Healthy preview reports different immutable inputs", async () => {
    const api = gateway({
      get: vi.fn(async () =>
        record(true, "ready", { sourceRevision: "d".repeat(40) }),
      ),
    });
    const adapter = new VclusterPreviewReadinessAdapter(api);
    await expect(adapter.waitReady(readinessInput())).resolves.toMatchObject({
      ready: false,
      phase: "contract-mismatch:sourceRevision",
    });
  });

  it.each([
    [
      "platform revision",
      { platformRevision: "d".repeat(40) },
      "platformRevision",
    ],
    ["lane", { lane: "management" }, "lane"],
    ["owner kind", { owner: { kind: "automation", id: "session-1" } }, "owner"],
    ["owner id", { owner: { kind: "session", id: "session-2" } }, "owner"],
    [
      "origin kind",
      { origin: { kind: "workflow", reference: "session-1" } },
      "origin",
    ],
    [
      "origin reference",
      { origin: { kind: "interactive-session", reference: "session-2" } },
      "origin",
    ],
    ["lifecycle", { lifecycle: "retained" }, "lifecycle"],
    [
      "request id",
      { provenance: { ...EXPECTED_PROVENANCE, requestId: "request-2" } },
      "provenance",
    ],
    [
      "requested at",
      {
        provenance: {
          ...EXPECTED_PROVENANCE,
          requestedAt: "2026-07-09T20:00:01Z",
        },
      },
      "provenance",
    ],
    [
      "platform repository",
      {
        provenance: {
          ...EXPECTED_PROVENANCE,
          platformRepository: "attacker/stacks",
        },
      },
      "provenance",
    ],
    [
      "source repository",
      {
        provenance: {
          ...EXPECTED_PROVENANCE,
          sourceRepository: "attacker/workflow-builder",
        },
      },
      "provenance",
    ],
    ["services", { services: ["workflow-orchestrator"] }, "services"],
    ["allocation", { allocation: { kind: "warm" } }, "allocation"],
    [
      "images",
      {
        images: {
          "workflow-builder": `ghcr.io/pittampalliorg/workflow-builder@sha256:${"e".repeat(64)}`,
        },
      },
      "images",
    ],
    [
      "catalog digest",
      { catalogDigest: `sha256:${"f".repeat(64)}` },
      "catalogDigest",
    ],
  ] as const)(
    "fails readiness when a Healthy preview changes exact %s authority",
    async (_description, override, mismatch) => {
      const api = gateway({
        get: vi.fn(async () => record(true, "ready", override)),
      });
      const adapter = new VclusterPreviewReadinessAdapter(api);

      await expect(adapter.waitReady(readinessInput())).resolves.toMatchObject({
        ready: false,
        phase: `contract-mismatch:${mismatch}`,
      });
    },
  );

  it("checks freshness through the privileged inventory adapter", async () => {
    const api = gateway({
      get: vi
        .fn()
        .mockResolvedValueOnce(record(false, "absent"))
        .mockResolvedValueOnce(record(true, "ready")),
    });
    const adapter = new VclusterPreviewInventoryAdapter(api);
    await expect(adapter.inspect("acceptance-one")).resolves.toEqual({
      exists: false,
      phase: "absent",
    });
    await expect(adapter.inspect("acceptance-one")).resolves.toEqual({
      exists: true,
      phase: "ready",
    });
  });

  it("proves Ready service containers run the exact immutable image digest", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const image = `ghcr.io/pittampalliorg/workflow-builder@${digest}`;
    const api = gateway({
      runtime: vi.fn(async () => ({
        name: "acceptance-one",
        resourceName: "acceptance-one",
        reconciliationSucceeded: true,
        upJob: {
          name: "vcpreview-up-acceptance-one",
          found: true,
          active: false,
          succeeded: true,
          failed: false,
        },
        services: [
          {
            service: "workflow-builder",
            containers: [
              {
                pod: "workflow-builder-abc",
                image,
                imageId: `ghcr.io/pittampalliorg/workflow-builder@${digest}`,
                ready: true,
              },
            ],
          },
        ],
      })),
    });
    await expect(
      new VclusterPreviewRuntimeInspectionAdapter(api).waitForImages({
        name: "acceptance-one",
        images: { "workflow-builder": image },
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      ok: true,
      checks: [{ service: "workflow-builder", ok: true }],
    });
  });

  it("fails runtime proof for a stale digest", async () => {
    const expected = `ghcr.io/pittampalliorg/workflow-builder@sha256:${"c".repeat(64)}`;
    const api = gateway({
      runtime: vi.fn(async () => ({
        name: "acceptance-one",
        resourceName: "acceptance-one",
        reconciliationSucceeded: true,
        upJob: {
          name: "vcpreview-up-acceptance-one",
          found: true,
          active: false,
          succeeded: true,
          failed: false,
        },
        services: [
          {
            service: "workflow-builder",
            containers: [
              {
                pod: "workflow-builder-old",
                image: `ghcr.io/pittampalliorg/workflow-builder@sha256:${"d".repeat(64)}`,
                imageId: `ghcr.io/pittampalliorg/workflow-builder@sha256:${"d".repeat(64)}`,
                ready: true,
              },
            ],
          },
        ],
      })),
    });
    await expect(
      new VclusterPreviewRuntimeInspectionAdapter(api).waitForImages({
        name: "acceptance-one",
        images: { "workflow-builder": expected },
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [
        {
          service: "workflow-builder",
          ok: false,
          observedImages: [expect.stringContaining(`${"d".repeat(64)}`)],
        },
      ],
    });
  });

  it("rejects Ready digest-matched pods until reconciliation completes", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const image = `ghcr.io/pittampalliorg/workflow-builder@${digest}`;
    const api = gateway({
      runtime: vi.fn(async () => ({
        name: "acceptance-one",
        resourceName: "acceptance-one",
        reconciliationSucceeded: false,
        upJob: {
          name: "vcpreview-up-acceptance-one",
          found: true,
          active: true,
          succeeded: false,
          failed: false,
        },
        services: [
          {
            service: "workflow-builder",
            containers: [
              {
                pod: "workflow-builder-abc",
                image,
                imageId: image,
                ready: true,
              },
            ],
          },
        ],
      })),
    });

    await expect(
      new VclusterPreviewRuntimeInspectionAdapter(api).waitForImages({
        name: "acceptance-one",
        images: { "workflow-builder": image },
        timeoutMs: 0,
      }),
    ).resolves.toMatchObject({
      ok: false,
      checks: [
        {
          service: "workflow-builder",
          ok: false,
          detail: "preview reconciliation has not completed",
        },
      ],
    });
  });

  it("waits for typed teardown convergence proof", async () => {
    const api = gateway({
      teardown: vi.fn(async () => record(false, "terminating")),
      cleanup: vi
        .fn()
        .mockResolvedValueOnce({
          name: "acceptance-one",
          resourceName: "acceptance-one",
          complete: false,
          phase: "pending",
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
        })
        .mockResolvedValueOnce({
          name: "acceptance-one",
          resourceName: "acceptance-one",
          complete: true,
          phase: "complete",
          checks: {
            runnerSucceeded: true,
            previewEnvironmentAbsent: true,
            applicationAbsent: true,
            agentRegistrationAbsent: true,
            agentNamespacesAbsent: true,
            databaseAbsent: true,
            natsStreamAbsent: true,
            headlampRegistrationAbsent: true,
            tailnetEgressAbsent: true,
            hostNamespaceAbsent: true,
            storageScopeAbsent: true,
            runnerIdentityAbsent: true,
          },
          message: null,
        }),
    });
    const adapter = new VclusterPreviewTeardownAdapter(
      api,
      vi.fn(async () => undefined),
      1,
    );
    await expect(
      adapter.teardown({
        name: "acceptance-one",
        timeoutMs: 100,
        guard: {
          mode: "owned",
          requestId: "request-1",
          sourceRevision: SOURCE_SHA as never,
        },
      }),
    ).resolves.toMatchObject({
      complete: true,
      phase: "complete",
      checks: { "host-namespace-absent": true },
    });
    expect(api.teardown).toHaveBeenCalledWith("acceptance-one", {
      mode: "owned",
      requestId: "request-1",
      sourceRevision: SOURCE_SHA,
    });
    expect(api.cleanup).toHaveBeenCalledTimes(2);
  });

  it("returns a typed timeout when cleanup proof is incomplete", async () => {
    const api = gateway({
      teardown: vi.fn(async () => record(false, "terminating")),
      cleanup: vi.fn(async () => ({
        name: "acceptance-one",
        resourceName: "acceptance-one",
        complete: false,
        phase: "pending" as const,
        checks: {
          runnerSucceeded: true,
          previewEnvironmentAbsent: true,
          applicationAbsent: true,
          agentRegistrationAbsent: false,
          agentNamespacesAbsent: false,
          databaseAbsent: true,
          natsStreamAbsent: true,
          headlampRegistrationAbsent: true,
          tailnetEgressAbsent: true,
          hostNamespaceAbsent: true,
          storageScopeAbsent: true,
          runnerIdentityAbsent: false,
        },
        message: null,
      })),
    });
    await expect(
      new VclusterPreviewTeardownAdapter(api).teardown({
        name: "acceptance-one",
        timeoutMs: 0,
        guard: {
          mode: "owned",
          requestId: "request-1",
          sourceRevision: SOURCE_SHA as never,
        },
      }),
    ).resolves.toMatchObject({
      complete: false,
      phase: "timeout",
      checks: { "agent-registration-absent": false },
      message: expect.stringContaining("timed out"),
    });
  });

  it("runs BFF, data-plane, and agent workflow checks", async () => {
    const states = new Map([
      ["data-exec", "success"],
      ["agent-exec", "success"],
    ]);
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (path.endsWith("/api/health")) return response({ ok: true });
        if (path.includes("preview-data-plane-smoke/webhook"))
          return response({ executionId: "data-exec" });
        if (path.includes("preview-agent-smoke/webhook"))
          return response({ executionId: "agent-exec" });
        const execution = path.includes("data-exec")
          ? "data-exec"
          : "agent-exec";
        return response({ status: states.get(execution) });
      },
    );
    const mintControl = vi.fn(() => "d".repeat(64));
    const verifier = new HttpPreviewEnvironmentVerifier({
      fetch: fetchMock as typeof fetch,
      capabilities: { mintControl },
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      verifier.verify({
        environment: environment("https://acceptance.example.test"),
        images: [],
      }),
    ).resolves.toEqual({
      ok: true,
      checks: [
        { name: "bff-health", ok: true },
        { name: "preview-data-plane-smoke", ok: true },
        { name: "preview-agent-smoke", ok: true },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("data-exec/status"),
      expect.objectContaining({
        headers: { "X-Preview-Control-Capability": "d".repeat(64) },
      }),
    );
    expect(
      fetchMock.mock.calls.every(([, init]) => init?.redirect === "error"),
    ).toBe(true);
    expect(mintControl).toHaveBeenCalledWith({
      previewName: "acceptance-one",
      environmentRequestId: "request-1",
      environmentPlatformRevision: "a".repeat(40),
      environmentSourceRevision: "b".repeat(40),
      catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
    });
  });

  it.each([
    [
      "health",
      [{ name: "bff-health", ok: false, detail: "HTTP unreachable" }],
    ],
    [
      "start",
      [
        { name: "bff-health", ok: true },
        {
          name: "preview-data-plane-smoke",
          ok: false,
          detail: "start HTTP unreachable",
        },
      ],
    ],
    [
      "status",
      [
        { name: "bff-health", ok: true },
        {
          name: "preview-data-plane-smoke",
          ok: false,
          detail: "timed out",
        },
      ],
    ],
  ] as const)(
    "fails closed when fetch rejects a candidate %s redirect",
    async (stage, expectedChecks) => {
      let now = 1_000;
      const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
      const sleep = vi.fn(async (milliseconds: number) => {
        now += Math.max(1, milliseconds);
      });
      const fetchMock = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
          expect(init?.redirect).toBe("error");
          const path = String(url);
          if (
            (stage === "health" && path.endsWith("/api/health")) ||
            (stage === "start" && path.includes("/webhook")) ||
            (stage === "status" && path.includes("/status"))
          ) {
            throw new TypeError("redirect rejected");
          }
          if (path.endsWith("/api/health")) return response({ ok: true });
          if (path.includes("/webhook"))
            return response({ executionId: "data-exec" });
          return response({ status: "success" });
        },
      );
      const verifier = new HttpPreviewEnvironmentVerifier({
        fetch: fetchMock as typeof fetch,
        capabilities: { mintControl: vi.fn(() => "d".repeat(64)) },
        sleep,
        pollMs: 1,
        timeoutMs: 3,
        runAgentSmoke: false,
      });

      try {
        await expect(
          verifier.verify({
            environment: environment("https://acceptance.example.test"),
            images: [],
          }),
        ).resolves.toEqual({ ok: false, checks: expectedChecks });
      } finally {
        dateNow.mockRestore();
      }
      expect(
        fetchMock.mock.calls.every(([, init]) => init?.redirect === "error"),
      ).toBe(true);
    },
  );

  it("waits for transient BFF unavailability before starting workflow checks", async () => {
    let healthAttempts = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/health")) {
        healthAttempts += 1;
        if (healthAttempts === 1) throw new TypeError("connection refused");
        return response({ ok: true });
      }
      if (path.includes("preview-data-plane-smoke/webhook"))
        return response({ executionId: "data-exec" });
      return response({ status: "success" });
    });
    const sleep = vi.fn(async () => undefined);
    const mintControl = vi.fn(() => "d".repeat(64));
    const verifier = new HttpPreviewEnvironmentVerifier({
      fetch: fetchMock as typeof fetch,
      capabilities: { mintControl },
      sleep,
      pollMs: 1,
      timeoutMs: 100,
      runAgentSmoke: false,
    });

    await expect(
      verifier.verify({
        environment: environment("https://acceptance.example.test"),
        images: [],
      }),
    ).resolves.toEqual({
      ok: true,
      checks: [
        { name: "bff-health", ok: true },
        { name: "preview-data-plane-smoke", ok: true },
      ],
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${ACCEPTANCE_API_BASE}/api/health`,
      `${ACCEPTANCE_API_BASE}/api/health`,
      `${ACCEPTANCE_API_BASE}/api/workflows/preview-data-plane-smoke/webhook`,
      `${ACCEPTANCE_API_BASE}/api/internal/agent/workflows/executions/data-exec/status`,
    ]);
    expect(mintControl).toHaveBeenCalledTimes(1);
  });

  it("bounds failed BFF readiness and does not start workflow checks", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request) =>
      response({}, 503),
    );
    let now = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const mintControl = vi.fn(() => "d".repeat(64));
    const verifier = new HttpPreviewEnvironmentVerifier({
      fetch: fetchMock as typeof fetch,
      capabilities: { mintControl },
      sleep,
      pollMs: 10,
      timeoutMs: 25,
    });

    try {
      await expect(
        verifier.verify({
          environment: environment("https://acceptance.example.test"),
          images: [],
        }),
      ).resolves.toEqual({
        ok: false,
        checks: [{ name: "bff-health", ok: false, detail: "HTTP 503" }],
      });
    } finally {
      dateNow.mockRestore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [10], [5]]);
    expect(mintControl).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(
        ([url]) => String(url) === `${ACCEPTANCE_API_BASE}/api/health`,
      ),
    ).toBe(true);
  });

  it("fails before workflow checks when no preview endpoint is resolvable", async () => {
    const fetchMock = vi.fn();
    const verifier = new HttpPreviewEnvironmentVerifier({
      fetch: fetchMock as typeof fetch,
      capabilities: { mintControl: vi.fn(() => "d".repeat(64)) },
    });
    const unresolved = {
      ...environment(null),
      name: "a".repeat(40),
    } as PreviewEnvironment;

    await expect(
      verifier.verify({ environment: unresolved, images: [] }),
    ).resolves.toEqual({
      ok: false,
      checks: [
        {
          name: "bff-health",
          ok: false,
          detail: "preview URL is not resolvable",
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
