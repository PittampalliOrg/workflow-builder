import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewDevelopmentEnvironmentService } from "$lib/server/application/preview-development-environment";
import type {
  PreviewEnvironmentLaunchOutcome,
  PreviewEnvironmentUserLaunchInput,
  PreviewDevelopmentTarget,
} from "$lib/server/application/ports";
import type {
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewRecord,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";

const PARENT = "parent-execution-1";
const PLATFORM = "a".repeat(40);
const SOURCE = "b".repeat(40);
const CATALOG = `sha256:${"c".repeat(64)}` as const;
const REQUEST = "request-1";

function operation(kind: string, digit = "d") {
  return `pdt-${kind}-${digit.repeat(64)}`;
}

function target(): PreviewDevelopmentTarget {
  return {
    previewName: "feature-one",
    environmentRequestId: REQUEST,
    platformRevision: PLATFORM,
    sourceRevision: SOURCE,
    catalogDigest: CATALOG,
  };
}

function record(input: {
  binding: string;
  ownerId?: string;
  phase?: string;
  ready?: boolean;
}): VclusterPreviewRecord {
  return {
    name: "feature-one",
    phase: input.phase ?? "provisioning",
    ready: input.ready ?? false,
    url: input.ready ? "https://wfb-feature-one.tailnet.ts.net/" : null,
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "retained",
    origin: { kind: "workflow", reference: PARENT },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: "2026-07-17T12:00:00.000Z",
    lastActive: "2026-07-16T12:00:00.000Z",
    protected: false,
    bootSeconds: 10,
    platformRevision: PLATFORM,
    sourceRevision: SOURCE,
    profile: "app-live",
    lane: "application",
    mode: "live",
    owner: { kind: "user", id: input.ownerId ?? "admin-1" },
    services: ["workflow-builder"],
    provenance: {
      requestId: REQUEST,
      requestedAt: "2026-07-16T12:00:00.000Z",
      platformRepository: "PittampalliOrg/stacks",
      sourceRepository: "PittampalliOrg/workflow-builder",
      parentEnvironmentId: input.binding,
    },
    trustedCode: true,
    allocation: { kind: "cold" },
    images: {},
    catalogDigest: CATALOG,
  };
}

function cleanup(): VclusterPreviewCleanupSnapshot {
  return {
    name: "feature-one",
    resourceName: "feature-one",
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
  };
}

function ticket(): VclusterPreviewTeardownTicket {
  return {
    name: "feature-one",
    environmentUid: "uid-1",
    requestId: REQUEST,
    sourceRevision: SOURCE,
    signature: "e".repeat(64),
  };
}

function harness() {
  let launchInput: PreviewEnvironmentUserLaunchInput | null = null;
  const launchForUser = vi.fn(
    async (
      input: PreviewEnvironmentUserLaunchInput,
    ): Promise<PreviewEnvironmentLaunchOutcome> => {
      launchInput = input;
      return {
        ok: true as const,
        environment: {
          name: input.name,
          profile: "app-live" as const,
          lane: "application" as const,
          capabilities: ["service-live-sync" as const],
          placement: "dev-vcluster" as const,
          platformRevision: PLATFORM as never,
          sourceRevision: SOURCE as never,
          catalogDigest: CATALOG,
          services: input.services ?? [],
          candidatePaths: [],
          owner: { kind: "user" as const, id: input.userId },
          origin: {
            kind: "workflow" as const,
            reference: input.workflowExecutionId,
          },
          ttlHours: input.ttlHours ?? 24,
          mode: "live" as const,
          imageOverrides: {},
          lifecycle: "retained" as const,
          allocation: { kind: "cold" as const },
          provenance: {
            requestId: REQUEST,
            requestedAt: "2026-07-16T12:00:00.000Z",
            platformRepository: "PittampalliOrg/stacks",
            sourceRepository: "PittampalliOrg/workflow-builder",
            parentEnvironmentId: input.provenance?.parentEnvironmentId,
          },
          id: input.name,
          lifecycleState: "provisioning" as const,
          createdAt: "2026-07-16T12:00:00.000Z",
          expiresAt: "2026-07-17T12:00:00.000Z",
          runtime: {
            placement: "dev-vcluster" as const,
            phase: "provisioning",
            ready: false,
            url: null,
            allocationId: null,
            pooled: false,
          },
        },
      };
    },
  );
  const get = vi.fn(async () => {
    if (!launchInput?.provenance?.parentEnvironmentId) {
      throw new Error("launch binding unavailable");
    }
    return record({ binding: launchInput.provenance.parentEnvironmentId });
  });
  const status = vi.fn(async () => cleanup());
  const cleanupPreview = vi.fn(async () => cleanup());
  const teardown = vi.fn(async () => ({
    preview: { ...record({ binding: "unused" }), phase: "terminating" },
    ticket: ticket(),
  }));
  const deps = {
    executions: {
      getById: vi.fn(async () => ({
        id: PARENT,
        userId: "admin-1",
        projectId: "project-1",
        status: "running" as const,
      })) as never,
    },
    admins: { isPlatformAdmin: vi.fn(async () => true) },
    scope: { isControlPlane: vi.fn(() => true) },
    environments: {
      previewNativeServices: () => ["workflow-builder"],
      launchForUser,
    },
    previews: { get, status, cleanup: cleanupPreview },
    teardown: { teardown },
  };
  return {
    deps,
    launchForUser,
    get,
    status,
    cleanupPreview,
    teardown,
    service: new ApplicationPreviewDevelopmentEnvironmentService(deps),
    launchInput: () => launchInput,
  };
}

describe("host preview development environment lifecycle", () => {
  it("derives actor, workflow provenance, immutable target, and fixed launch policy", async () => {
    const h = harness();
    const result = await h.service.launchEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("launch-environment"),
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });

    expect(result).toMatchObject({
      kind: "launch-environment",
      operationId: operation("launch-environment"),
      target: target(),
      phase: "provisioning",
      ready: false,
      reused: false,
    });
    expect(h.launchForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feature-one",
        userId: "admin-1",
        workflowExecutionId: PARENT,
        profile: "app-live",
        lane: "application",
        capabilities: ["service-live-sync"],
        services: ["workflow-builder"],
        ttlHours: 8,
        lifecycle: "retained",
        allocation: { kind: "cold" },
      }),
    );
    expect(h.launchInput()?.provenance?.parentEnvironmentId).toMatch(
      /^workflow-execution:sha256:[0-9a-f]{64}:launch:sha256:[0-9a-f]{64}$/,
    );
    expect(h.launchInput()).not.toHaveProperty("platformRevision");
    expect(h.launchInput()).not.toHaveProperty("sourceRevision");
  });

  it("accepts only the exact same-name replay contract", async () => {
    const h = harness();
    let captured: PreviewEnvironmentUserLaunchInput | null = null;
    h.launchForUser.mockImplementationOnce(async (input) => {
      captured = input;
      return { ok: false, reason: "conflict", message: "exists" } as const;
    });
    h.get.mockImplementation(async () =>
      record({
        binding: captured?.provenance?.parentEnvironmentId ?? "",
      }),
    );

    const result = await h.service.launchEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("launch-environment"),
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
    expect(result.reused).toBe(true);
    const originalBinding =
      h.launchForUser.mock.calls[0]?.[0].provenance?.parentEnvironmentId ?? "";

    h.launchForUser.mockImplementationOnce(async () => {
      return { ok: false, reason: "conflict", message: "exists" } as const;
    });
    h.get.mockResolvedValueOnce(record({ binding: originalBinding }));
    await expect(
      h.service.launchEnvironment({
        parentExecutionId: PARENT,
        operationId: operation("launch-environment", "f"),
        launch: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it("keeps status read-only and rejects a replaced generation", async () => {
    const h = harness();
    await h.service.launchEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("launch-environment"),
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
    h.get.mockResolvedValueOnce(
      record({
        binding: h.launchInput()!.provenance!.parentEnvironmentId!,
        phase: "ready",
        ready: true,
      }),
    );
    await expect(
      h.service.getEnvironmentStatus({
        parentExecutionId: PARENT,
        operationId: operation("get-environment-status"),
        target: target(),
      }),
    ).resolves.toMatchObject({ phase: "ready", ready: true, target: target() });
    expect(h.teardown).not.toHaveBeenCalled();

    h.get.mockResolvedValueOnce({
      ...record({ binding: h.launchInput()!.provenance!.parentEnvironmentId! }),
      provenance: {
        ...record({ binding: "unused" }).provenance,
        requestId: "replacement",
        parentEnvironmentId: h.launchInput()!.provenance!.parentEnvironmentId!,
      },
    });
    await expect(
      h.service.getEnvironmentStatus({
        parentExecutionId: PARENT,
        operationId: operation("get-environment-status", "f"),
        target: target(),
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
  });

  it("fences teardown and returns physical cleanup proof", async () => {
    const h = harness();
    await h.service.launchEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("launch-environment"),
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
    const teardownResult = await h.service.teardownEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("teardown-environment"),
      target: target(),
    });
    expect(h.teardown).toHaveBeenCalledWith({
      name: "feature-one",
      actorUserId: "admin-1",
      expectedRequestId: REQUEST,
      expectedSourceRevision: SOURCE,
      projectId: "project-1",
      discardUnarchived: true,
    });
    expect(teardownResult).toMatchObject({ ticket: ticket(), complete: false });

    await expect(
      h.service.getEnvironmentTeardownStatus({
        parentExecutionId: PARENT,
        operationId: operation("get-environment-teardown-status"),
        target: target(),
        ticket: ticket(),
      }),
    ).resolves.toMatchObject({ complete: true, cleanup: { complete: true } });
    expect(h.status).toHaveBeenCalledWith(ticket());
  });

  it("accepts an exact teardown replay after physical absence is proved", async () => {
    const h = harness();
    await h.service.launchEnvironment({
      parentExecutionId: PARENT,
      operationId: operation("launch-environment"),
      launch: {
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: 8,
        retainAfterCompletion: false,
      },
    });
    h.get.mockRejectedValueOnce(new Error("preview is absent"));

    await expect(
      h.service.teardownEnvironment({
        parentExecutionId: PARENT,
        operationId: operation("teardown-environment"),
        target: target(),
      }),
    ).resolves.toMatchObject({
      target: target(),
      phase: "absent",
      ticket: null,
      complete: true,
    });
    expect(h.cleanupPreview).toHaveBeenCalledWith("feature-one");
    expect(h.teardown).not.toHaveBeenCalled();
  });

  it("requires an active platform-admin execution on the host control plane", async () => {
    const h = harness();
    h.deps.scope.isControlPlane.mockReturnValueOnce(false);
    await expect(
      h.service.launchEnvironment({
        parentExecutionId: PARENT,
        operationId: operation("launch-environment"),
        launch: {
          environmentName: "feature-one",
          services: ["workflow-builder"],
          ttlHours: 8,
          retainAfterCompletion: false,
        },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });

    h.deps.admins.isPlatformAdmin.mockResolvedValueOnce(false);
    await expect(
      h.service.getEnvironmentStatus({
        parentExecutionId: PARENT,
        operationId: operation("get-environment-status"),
        target: target(),
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
