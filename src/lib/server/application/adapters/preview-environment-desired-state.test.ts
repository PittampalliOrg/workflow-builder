import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  buildPreviewEnvironmentDesiredStateManifest,
  BrokeredVclusterPreviewGateway,
  DesiredStateVclusterPreviewGateway,
  KubernetesPreviewEnvironmentDesiredStateAdapter,
  PreviewEnvironmentDesiredStateConflictError,
  PreviewEnvironmentDesiredStateOwnershipError,
  previewEnvironmentHubKubeFetch,
} from "$lib/server/application/adapters/preview-environment-desired-state";
import { validatePreviewEnvironmentLaunchSpec } from "$lib/server/application/preview-environments";
import type {
  PreviewEnvironmentDesiredStatePort,
  PreviewEnvironmentDeletionAcknowledgement,
  PreviewEnvironmentDeletionIntent,
  PreviewEnvironmentVersionedServiceCatalogPort,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

const PLATFORM = "a".repeat(40);
const SOURCE = "b".repeat(40);
const CATALOG = `sha256:${"c".repeat(64)}` as const;
const REQUESTED_AT = "2026-07-10T12:00:00.000Z";
const API_PATH =
  "/apis/preview.stacks.io/v1alpha1/namespaces/preview-system/previewenvironments";

const catalog: PreviewEnvironmentVersionedServiceCatalogPort = {
  currentDigest: () => CATALOG,
  listPreviewNativeServices: () => ["workflow-builder"],
  assertPreviewNativeServices: (services) => services,
};

const command = validatePreviewEnvironmentLaunchSpec(
  {
    name: "feature-one",
    profile: "app-live",
    lane: "application",
    capabilities: ["service-live-sync"],
    platformRevision: PLATFORM,
    sourceRevision: SOURCE,
    services: ["workflow-builder"],
    candidatePaths: [],
    owner: { kind: "user", id: "admin-1" },
    origin: { kind: "user" },
    ttlHours: 24,
    mode: "live",
    lifecycle: "retained",
    allocation: { kind: "cold" },
    provenance: {
      requestId: "request-1",
      requestedAt: REQUESTED_AT,
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
    },
  },
  CATALOG,
);

function resource(
  overrides: Record<string, unknown> = {},
): Record<string, any> {
  const manifest = buildPreviewEnvironmentDesiredStateManifest(command);
  return {
    ...manifest,
    metadata: {
      ...(manifest.metadata as Record<string, unknown>),
      uid: "uid-1",
      generation: 1,
      resourceVersion: "7",
    },
    ...overrides,
  };
}

function deletingResource() {
  const value = resource();
  value.metadata.uid = "12345678-1234-1234-1234-123456789abc";
  value.metadata.deletionTimestamp = "2026-07-10T12:02:00.000Z";
  const payload = {
    catalogDigest: command.catalogDigest,
    deletionTimestamp: value.metadata.deletionTimestamp,
    environmentUid: value.metadata.uid,
    name: command.name,
    platformRevision: command.platformRevision,
    requestId: command.provenance.requestId,
    sourceRevision: command.sourceRevision,
  };
  const intent: PreviewEnvironmentDeletionIntent = {
    id: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
    name: command.name,
    environmentUid: value.metadata.uid,
    requestId: command.provenance.requestId,
    platformRevision: command.platformRevision,
    sourceRevision: command.sourceRevision,
    catalogDigest: command.catalogDigest,
    deletionTimestamp: value.metadata.deletionTimestamp,
  };
  value.status = { phase: "Terminating", deletionIntent: intent };
  return { value, intent };
}

function deletionAcknowledgement(
  intent: PreviewEnvironmentDeletionIntent,
): PreviewEnvironmentDeletionAcknowledgement {
  return {
    intentId: intent.id,
    environmentUid: intent.environmentUid,
    requestId: intent.requestId,
    platformRevision: intent.platformRevision,
    sourceRevision: intent.sourceRevision,
    catalogDigest: intent.catalogDigest,
    observedAt: "2026-07-10T12:03:00.000Z",
    resourceName: intent.name,
    runner: {
      jobName: `vcpreview-down-${intent.name}`,
      jobUid: "87654321-4321-4321-4321-cba987654321",
      generation: `op:${"d".repeat(32)}`,
    },
    checks: {
      runnerSucceeded: true,
      databaseAbsent: true,
      natsStreamAbsent: true,
      tailnetEgressAbsent: true,
      hostNamespaceAbsent: true,
      storageScopeAbsent: true,
      runnerIdentityAbsent: true,
    },
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function previewRecord(): VclusterPreviewRecord {
  return {
    name: command.name,
    phase: "provisioning",
    ready: false,
    url: null,
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "retained",
    origin: { kind: "user" },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: "2026-07-11T12:00:00.000Z",
    lastActive: null,
    protected: false,
    bootSeconds: 1,
    platformRevision: command.platformRevision,
    sourceRevision: command.sourceRevision,
    profile: command.profile,
    lane: command.lane,
    mode: command.mode,
    owner: command.owner,
    services: [...command.services],
    provenance: command.provenance,
    trustedCode: true,
    allocation: command.allocation,
    images: command.imageOverrides,
    catalogDigest: command.catalogDigest,
  };
}

function gateway(overrides: Partial<VclusterPreviewGatewayPort> = {}) {
  return {
    listWithCounts: vi.fn(async () => ({ previews: [], counts: null })),
    get: vi.fn(async () => previewRecord()),
    provision: vi.fn(async () => previewRecord()),
    teardown: vi.fn(async () => previewRecord()),
    runtime: vi.fn(async () => ({
      name: command.name,
      resourceName: command.name,
      reconciliationSucceeded: true,
      services: [],
    })),
    cleanup: vi.fn(async () => ({
      name: command.name,
      resourceName: command.name,
      complete: false,
      phase: "pending" as const,
      checks: {
        runnerSucceeded: true,
        previewEnvironmentAbsent: false,
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
      message: "waiting for hub desired state",
    })),
    touch: vi.fn(async () => ({
      name: command.name,
      state: "hot",
      resuming: false,
      lastActive: null,
    })),
    sleep: vi.fn(async () => ({
      ok: true as const,
      name: command.name,
      alreadySlept: false,
    })),
    ...overrides,
  } satisfies VclusterPreviewGatewayPort;
}

function launchInput() {
  return {
    name: command.name,
    lifecycle: command.lifecycle,
    origin: command.origin,
    ttlHours: command.ttlHours,
    platformRevision: command.platformRevision,
    sourceRevision: command.sourceRevision,
    catalogDigest: command.catalogDigest,
    candidatePaths: command.candidatePaths,
    delivery: "reconciler" as const,
    enrollMode: "agent" as const,
    profile: command.profile,
    lane: command.lane,
    mode: command.mode,
    allocation: command.allocation,
    imageOverrides: command.imageOverrides,
    owner: command.owner,
    services: command.services,
    provenance: command.provenance,
    trustedCode: true,
    createOnly: true,
  };
}

describe("KubernetesPreviewEnvironmentDesiredStateAdapter", () => {
  it("uses only the explicit least-privilege hub kubeconfig transport", async () => {
    expect(() => previewEnvironmentHubKubeFetch({})).toThrow(
      "PREVIEW_ENVIRONMENT_HUB_KUBECONFIG",
    );
    const remote = vi.fn(async () => json({ reason: "NotFound" }, 404));
    const fetch = previewEnvironmentHubKubeFetch(
      {
        PREVIEW_ENVIRONMENT_HUB_KUBECONFIG:
          "/var/run/preview-environment-hub/kubeconfig",
        PREVIEW_ENVIRONMENT_HUB_KUBECONFIG_CONTEXT: "hub-preview-control",
      },
      remote,
    );
    await fetch(`${API_PATH}/${command.name}`, { retries: 0 });
    expect(remote).toHaveBeenCalledWith(
      `${API_PATH}/${command.name}`,
      { retries: 0 },
      {
        kubeconfigPath: "/var/run/preview-environment-hub/kubeconfig",
        context: "hub-preview-control",
      },
    );
  });

  it("authors the exact immutable reconciler contract before returning", async () => {
    let stored: Record<string, unknown> | null = null;
    const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (init.method === "POST") {
        const submitted = JSON.parse(String(init.body));
        stored = {
          ...submitted,
          metadata: {
            ...submitted.metadata,
            uid: "uid-1",
            generation: 1,
            resourceVersion: "7",
          },
        };
        return json(stored, 201);
      }
      expect(path).toBe(`${API_PATH}/${command.name}`);
      return json(stored);
    });
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: fetch as never,
    });

    await expect(adapter.create(command)).resolves.toMatchObject({
      name: command.name,
      uid: "uid-1",
      generation: 1,
      phase: "Pending",
      ready: false,
    });
    const created = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(created).toEqual(
      buildPreviewEnvironmentDesiredStateManifest(command),
    );
    expect(created.spec.expiresAt).toBe("2026-07-11T12:00:00.000Z");
    expect(created.spec).not.toHaveProperty("capabilities");
  });

  it("makes same-contract 409 and ambiguous create retries idempotent", async () => {
    const retry = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async (_path, init = {}) =>
        init.method === "POST"
          ? json({ reason: "AlreadyExists" }, 409)
          : json(resource()),
      ),
    });
    await expect(retry.create(command)).resolves.toMatchObject({
      uid: "uid-1",
    });

    const ambiguous = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async (_path, init = {}) => {
        if (init.method === "POST") throw new Error("response lost");
        return json(resource());
      }),
    });
    await expect(ambiguous.create(command)).resolves.toMatchObject({
      uid: "uid-1",
    });
  });

  it("rejects a different-contract name collision", async () => {
    const colliding = resource();
    (colliding.spec as Record<string, unknown>).provenance = {
      ...((colliding.spec as Record<string, unknown>).provenance as object),
      requestId: "different-request",
    };
    const conflict = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async (_path, init = {}) =>
        init.method === "POST"
          ? json({ reason: "AlreadyExists" }, 409)
          : json(colliding),
      ),
    });
    await expect(conflict.create(command)).rejects.toBeInstanceOf(
      PreviewEnvironmentDesiredStateConflictError,
    );
  });

  it("preserves hostile durable state after an ambiguous create", async () => {
    const colliding = resource();
    (colliding.spec as Record<string, unknown>).sourceRevision = "d".repeat(40);
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async (_path, init = {}) => {
        if (init.method === "POST") throw new Error("response lost");
        return json(colliding);
      }),
    });
    await expect(adapter.create(command)).rejects.toBeInstanceOf(
      PreviewEnvironmentDesiredStateOwnershipError,
    );
  });

  it("rejects hostile tuple-bound status", async () => {
    const hostile = resource({
      status: {
        phase: "Ready",
        observedGeneration: 1,
        platformRevision: command.platformRevision,
        sourceRevision: "d".repeat(40),
        catalogDigest: command.catalogDigest,
        images: command.imageOverrides,
        application: {
          namespace: `preview-${command.name}`,
          name: `preview-${command.name}-workflow-builder`,
        },
      },
    });
    const reader = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async () => json(hostile)) as never,
    });
    await expect(reader.inspect(command)).rejects.toBeInstanceOf(
      PreviewEnvironmentDesiredStateOwnershipError,
    );
  });

  it("uses a Background UID-only precondition and waits for absence", async () => {
    let reads = 0;
    const fetch = vi.fn(async (_path: string, init: RequestInit = {}) => {
      if (init.method === "DELETE") return json({ kind: "Status" }, 202);
      reads += 1;
      return reads === 1 ? json(resource()) : json({ reason: "NotFound" }, 404);
    });
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: fetch as never,
      sleep: vi.fn(async () => undefined),
    });
    await adapter.deleteAndWait({
      name: command.name,
      guard: {
        mode: "owned",
        requestId: command.provenance.requestId,
        sourceRevision: command.sourceRevision,
      },
      timeoutMs: 1_000,
    });
    const deleteCall = fetch.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Background",
      preconditions: { uid: "uid-1" },
    });
  });

  it("preserves a same-name replacement that appears during convergence", async () => {
    let reads = 0;
    const replacement = resource();
    replacement.metadata.uid = "uid-2";
    const fetch = vi.fn(async (_path: string, init: RequestInit = {}) => {
      if (init.method === "DELETE") return json({ kind: "Status" }, 202);
      reads += 1;
      return reads === 1 ? json(resource()) : json(replacement);
    });
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: fetch as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.deleteAndWait({
        name: command.name,
        guard: {
          mode: "owned",
          requestId: command.provenance.requestId,
          sourceRevision: command.sourceRevision,
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(
      "PreviewEnvironment was replaced while deletion was pending",
    );
    expect(
      fetch.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("does not require a resourceVersion for UID-fenced deletion", async () => {
    const missingVersion = resource();
    delete (missingVersion.metadata as Record<string, unknown>).resourceVersion;
    let reads = 0;
    const fetch = vi.fn(async (_path: string, init: RequestInit = {}) => {
      if (init.method === "DELETE") return json({ kind: "Status" }, 202);
      reads += 1;
      return reads === 1
        ? json(missingVersion)
        : json({ reason: "NotFound" }, 404);
    });
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      adapter.deleteAndWait({
        name: command.name,
        guard: {
          mode: "owned",
          requestId: command.provenance.requestId,
          sourceRevision: command.sourceRevision,
        },
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
    const deleteCall = fetch.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(JSON.parse(String(deleteCall?.[1]?.body))).toEqual({
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Background",
      preconditions: { uid: "uid-1" },
    });
  });

  it("refuses deletion with the wrong ownership tuple", async () => {
    const fetch = vi.fn(async () => json(resource()));
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: fetch as never,
    });
    await expect(
      adapter.deleteAndWait({
        name: command.name,
        guard: {
          mode: "owned",
          requestId: "attacker",
          sourceRevision: command.sourceRevision,
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(PreviewEnvironmentDesiredStateOwnershipError);
    expect(fetch).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("lists direct CR deletions only after the controller-authored intent is exact", async () => {
    const { value, intent } = deletingResource();
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async () => json({ items: [resource(), value] })),
    });

    await expect(adapter.listPending()).resolves.toEqual([intent]);
  });

  it("patches a tuple-bound cleanup acknowledgement through the status subresource", async () => {
    const { value, intent } = deletingResource();
    const acknowledgement = deletionAcknowledgement(intent);
    const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
      if (init.method === "PATCH") {
        expect(path).toBe(`${API_PATH}/${command.name}/status`);
        expect(init.headers).toEqual({
          "Content-Type": "application/merge-patch+json",
        });
        const patch = JSON.parse(String(init.body));
        expect(patch.metadata.resourceVersion).toBe("7");
        return json({
          ...value,
          status: {
            ...value.status,
            deletionAcknowledgement: patch.status.deletionAcknowledgement,
          },
        });
      }
      return json(value);
    });
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch,
    });

    await expect(
      adapter.acknowledge(intent, acknowledgement),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not replay an already acknowledged deletion intent", async () => {
    const { value, intent } = deletingResource();
    value.status.deletionAcknowledgement = deletionAcknowledgement(intent);
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch: vi.fn(async () => json({ items: [value] })),
    });

    await expect(adapter.listPending()).resolves.toEqual([]);
  });

  it.each([
    ["resourceName", { resourceName: "another-preview" }],
    ["runner.jobName", { jobName: "vcpreview-down-another-preview" }],
    ["platformRevision", { platformRevision: "d".repeat(40) }],
    ["catalogDigest", { catalogDigest: `sha256:${"e".repeat(64)}` }],
  ] as Array<
    [
      string,
      {
        resourceName?: string;
        jobName?: string;
        platformRevision?: string;
        catalogDigest?: string;
      },
    ]
  >)(
    "keeps an intent pending when acknowledgement %s is mismatched",
    async (_case, change) => {
      const { value, intent } = deletingResource();
      const acknowledgement = deletionAcknowledgement(intent);
      value.status.deletionAcknowledgement = {
        ...acknowledgement,
        ...(change.resourceName ? { resourceName: change.resourceName } : {}),
        ...(change.platformRevision
          ? { platformRevision: change.platformRevision }
          : {}),
        ...(change.catalogDigest
          ? { catalogDigest: change.catalogDigest }
          : {}),
        runner: {
          ...acknowledgement.runner,
          ...(change.jobName ? { jobName: change.jobName } : {}),
        },
      };
      const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
        fetch: vi.fn(async () => json({ items: [value] })),
        now: () => Date.parse("2026-07-10T12:04:00.000Z"),
      });

      await expect(adapter.listPending()).resolves.toEqual([intent]);
    },
  );

  it("rejects a future-dated cleanup acknowledgement", async () => {
    const { intent } = deletingResource();
    const acknowledgement = {
      ...deletionAcknowledgement(intent),
      observedAt: "2026-07-11T12:03:00.000Z",
    };
    const fetch = vi.fn();
    const adapter = new KubernetesPreviewEnvironmentDesiredStateAdapter({
      fetch,
      now: () => Date.parse("2026-07-10T12:03:00.000Z"),
    });

    await expect(
      adapter.acknowledge(intent, acknowledgement),
    ).rejects.toBeInstanceOf(PreviewEnvironmentDesiredStateOwnershipError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("DesiredStateVclusterPreviewGateway", () => {
  it("creates and proves desired state before and after SEA up", async () => {
    const order: string[] = [];
    const desired = {
      create: vi.fn(async () => {
        order.push("desired:create");
        return {
          name: command.name,
          uid: "uid-1",
          generation: 1,
          phase: "Pending" as const,
          ready: false,
        };
      }),
      inspect: vi.fn(async () => {
        order.push("desired:inspect");
        return {
          name: command.name,
          uid: "uid-1",
          generation: 1,
          phase: "Provisioning" as const,
          ready: false,
        };
      }),
      deleteAndWait: vi.fn(),
      absent: vi.fn(async () => false),
    } satisfies PreviewEnvironmentDesiredStatePort;
    const sea = gateway({
      provision: vi.fn(async () => {
        order.push("sea:up");
        return previewRecord();
      }),
    });
    const adapter = new DesiredStateVclusterPreviewGateway({
      gateway: sea,
      desiredState: desired,
      catalog,
    });

    await adapter.provision(launchInput());
    expect(order).toEqual(["desired:create", "sea:up", "desired:inspect"]);
  });

  it("waits for finalizer-driven physical proof without resubmitting SEA down", async () => {
    const order: string[] = [];
    const desired = {
      create: vi.fn(),
      inspect: vi.fn(),
      deleteAndWait: vi.fn(async () => {
        order.push("desired:absent");
      }),
      absent: vi.fn(async () => true),
    } satisfies PreviewEnvironmentDesiredStatePort;
    const sea = gateway({
      teardown: vi.fn(async () => {
        order.push("sea:down");
        return previewRecord();
      }),
      cleanup: vi.fn(async () => {
        order.push("sea:proof");
        return {
          ...(await gateway().cleanup(command.name)),
          complete: true,
          phase: "complete" as const,
          checks: Object.fromEntries(
            Object.keys((await gateway().cleanup(command.name)).checks).map(
              (key) => [key, true],
            ),
          ) as never,
        };
      }),
    });
    const adapter = new DesiredStateVclusterPreviewGateway({
      gateway: sea,
      desiredState: desired,
      catalog,
    });

    await adapter.teardown(command.name, {
      mode: "owned",
      requestId: command.provenance.requestId,
      sourceRevision: command.sourceRevision,
    });
    expect(order).toEqual(["desired:absent", "sea:proof"]);
    expect(sea.teardown).not.toHaveBeenCalled();
  });

  it("compensates a failed SEA up in the same safe order", async () => {
    const order: string[] = [];
    const desired = {
      create: vi.fn(async () => ({
        name: command.name,
        uid: "uid-1",
        generation: 1,
        phase: "Pending" as const,
        ready: false,
      })),
      inspect: vi.fn(),
      deleteAndWait: vi.fn(async () => {
        order.push("desired:absent");
      }),
      absent: vi.fn(async () => true),
    } satisfies PreviewEnvironmentDesiredStatePort;
    const sea = gateway({
      provision: vi.fn(async () => {
        throw new Error("SEA connection closed after write");
      }),
      teardown: vi.fn(async () => {
        order.push("sea:down");
        return previewRecord();
      }),
    });
    const adapter = new DesiredStateVclusterPreviewGateway({
      gateway: sea,
      desiredState: desired,
      catalog,
    });

    await expect(adapter.provision(launchInput())).rejects.toThrow(
      "was compensated",
    );
    expect(order).toEqual(["desired:absent"]);
  });

  it("preserves both the provision and compensation failures", async () => {
    const desired = {
      create: vi.fn(async () => ({
        name: command.name,
        uid: "uid-1",
        generation: 1,
        phase: "Pending" as const,
        ready: false,
      })),
      inspect: vi.fn(),
      deleteAndWait: vi.fn(async () => {
        throw new Error("finalizer timeout");
      }),
      absent: vi.fn(async () => false),
    } satisfies PreviewEnvironmentDesiredStatePort;
    const adapter = new DesiredStateVclusterPreviewGateway({
      gateway: gateway({
        provision: vi.fn(async () => {
          throw new Error("SEA response lost");
        }),
      }),
      desiredState: desired,
      catalog,
    });
    const error = await adapter
      .provision(launchInput())
      .catch((cause) => cause);
    expect(error).toMatchObject({
      message: expect.stringContaining("compensation also failed"),
      cause: expect.any(AggregateError),
    });
    expect((error.cause as AggregateError).errors.map(String)).toEqual([
      "Error: SEA response lost",
      "Error: finalizer timeout",
    ]);
  });

  it("sources the PreviewEnvironment absence check from the physical broker", async () => {
    const desired = {
      create: vi.fn(),
      inspect: vi.fn(),
      deleteAndWait: vi.fn(),
      absent: vi.fn(async () => true),
    } satisfies PreviewEnvironmentDesiredStatePort;
    const adapter = new DesiredStateVclusterPreviewGateway({
      gateway: gateway(),
      desiredState: desired,
      catalog,
    });

    await expect(adapter.cleanup(command.name)).resolves.toMatchObject({
      complete: true,
      phase: "complete",
      checks: { previewEnvironmentAbsent: true },
      message: null,
    });
  });
});

describe("BrokeredVclusterPreviewGateway", () => {
  it("constructs and serves reads without hub desired-state credentials", async () => {
    const local = gateway();
    const brokerFetch = vi.fn();
    const adapter = new BrokeredVclusterPreviewGateway({
      gateway: local,
      fetch: brokerFetch as typeof fetch,
      baseUrl: () => null,
      token: () => null,
    });

    await expect(adapter.listWithCounts()).resolves.toMatchObject({
      previews: [],
    });
    expect(local.listWithCounts).toHaveBeenCalledOnce();
    expect(brokerFetch).not.toHaveBeenCalled();
  });

  it("sends guarded teardown only to the authenticated physical broker", async () => {
    const local = gateway();
    const sparseSeaReceipt = {
      name: command.name,
      phase: "terminating",
      ready: false,
      sourceRevision: null,
      provenance: null,
    };
    const guard = {
      mode: "owned" as const,
      requestId: command.provenance.requestId,
      sourceRevision: command.sourceRevision,
    };
    const brokerFetch = vi.fn(async () =>
      json({
        ok: true,
        preview: sparseSeaReceipt,
        receipt: {
          name: command.name,
          guard,
          desiredStateAbsent: true,
        },
      }),
    );
    const adapter = new BrokeredVclusterPreviewGateway({
      gateway: local,
      fetch: brokerFetch as typeof fetch,
      baseUrl: () => "http://preview-control-broker:3000/",
      token: () => "broker-token",
    });

    await expect(adapter.teardown(command.name, guard)).resolves.toEqual(
      sparseSeaReceipt,
    );
    expect(local.teardown).not.toHaveBeenCalled();
    expect(brokerFetch).toHaveBeenCalledWith(
      `http://preview-control-broker:3000/api/internal/preview-control/environment/${command.name}/teardown`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ guard }),
        headers: expect.objectContaining({
          "X-Preview-Control-Broker-Token": "broker-token",
        }),
      }),
    );
  });

  it("refuses unguarded destructive commands before network access", async () => {
    const brokerFetch = vi.fn();
    const adapter = new BrokeredVclusterPreviewGateway({
      gateway: gateway(),
      fetch: brokerFetch as typeof fetch,
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
    });
    await expect(
      adapter.teardown(command.name, undefined as never),
    ).rejects.toBeInstanceOf(PreviewEnvironmentDesiredStateOwnershipError);
    expect(brokerFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["desired-state-present", { desiredStateAbsent: false }],
    ["wrong-name", { name: "another-preview" }],
    [
      "wrong-guard",
      {
        guard: {
          mode: "owned",
          requestId: "another-request",
          sourceRevision: command.sourceRevision,
        },
      },
    ],
  ])(
    "rejects a compromised physical teardown receipt: %s",
    async (_case, change) => {
      const guard = {
        mode: "owned" as const,
        requestId: command.provenance.requestId,
        sourceRevision: command.sourceRevision,
      };
      const brokerFetch = vi.fn(async () =>
        json({
          ok: true,
          preview: {
            name: command.name,
            phase: "terminating",
            sourceRevision: null,
            provenance: null,
          },
          receipt: {
            name: command.name,
            guard,
            desiredStateAbsent: true,
            ...change,
          },
        }),
      );
      const adapter = new BrokeredVclusterPreviewGateway({
        gateway: gateway(),
        fetch: brokerFetch as typeof fetch,
        baseUrl: () => "http://preview-control-broker:3000",
        token: () => "broker-token",
      });

      await expect(
        adapter.teardown(command.name, guard),
      ).rejects.toBeInstanceOf(PreviewEnvironmentDesiredStateOwnershipError);
    },
  );

  it("gets cleanup convergence proof from the physical broker", async () => {
    const local = gateway();
    const cleanup = await local.cleanup(command.name);
    vi.mocked(local.cleanup).mockClear();
    const brokerFetch = vi.fn(async () => json({ ok: true, cleanup }));
    const adapter = new BrokeredVclusterPreviewGateway({
      gateway: local,
      fetch: brokerFetch as typeof fetch,
      baseUrl: () => "http://preview-control-broker:3000",
      token: () => "broker-token",
    });

    await expect(adapter.cleanup(command.name)).resolves.toEqual(cleanup);
    expect(local.cleanup).not.toHaveBeenCalled();
    expect(brokerFetch).toHaveBeenCalledWith(
      `http://preview-control-broker:3000/api/internal/preview-control/environment/${command.name}/cleanup`,
      expect.objectContaining({
        headers: { "X-Preview-Control-Broker-Token": "broker-token" },
      }),
    );
  });
});
