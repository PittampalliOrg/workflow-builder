import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewReadProxyService } from "$lib/server/application/preview-read-proxy";
import type {
  PreviewAccessPolicyPort,
  PreviewReadProxyPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

function fakeProxy(): PreviewReadProxyPort {
  return {
    listExecutions: vi.fn(async () => ({
      ok: true as const,
      data: { executions: [], total: 0 },
    })),
    getExecution: vi.fn(async () => ({
      ok: true as const,
      data: { id: "e1" },
    })),
    listExecutionArtifacts: vi.fn(async () => ({
      ok: true as const,
      data: [],
    })),
    fetchFileContent: vi.fn(async () => ({
      ok: true as const,
      data: { bytes: Buffer.alloc(0), contentType: null },
    })),
  };
}

function preview(
  overrides: Partial<VclusterPreviewRecord> = {},
): VclusterPreviewRecord {
  return {
    name: "alice-dev",
    phase: "ready",
    ready: true,
    url: "https://alice-dev.example.test",
    targetCluster: "dev",
    pool: null,
    state: "hot",
    lifecycle: "ephemeral",
    origin: { kind: "user" },
    legacyOrigin: "user",
    prNumber: null,
    expiresAt: null,
    lastActive: null,
    protected: false,
    bootSeconds: null,
    platformRevision: "a".repeat(40),
    sourceRevision: "b".repeat(40),
    profile: "app-live",
    lane: "application",
    mode: "live",
    owner: { kind: "user", id: "owner-1" },
    services: ["workflow-builder"],
    provenance: { requestId: "request-1" },
    trustedCode: true,
    allocation: { kind: "cold" },
    images: {},
    catalogDigest: `sha256:${"d".repeat(64)}`,
    ...overrides,
  };
}

function harness(record = preview()) {
  const proxy = fakeProxy();
  const access: PreviewAccessPolicyPort = {
    authorize: vi.fn(async ({ actorUserId }) => ({
      preview: record,
      ownerId: record.owner?.id ?? "",
      actorIsOwner: actorUserId === record.owner?.id,
      actorIsPlatformAdmin: actorUserId !== record.owner?.id,
    })),
  };
  const scope = { isControlPlane: vi.fn(() => true) };
  return {
    proxy,
    access,
    scope,
    service: new ApplicationPreviewReadProxyService({ proxy, access, scope }),
  };
}

describe("ApplicationPreviewReadProxyService", () => {
  it("builds the read target from the exact record authorized for the actor", async () => {
    const h = harness(preview({ pool: "pool-1" }));

    const result = await h.service.listPreviewExecutions({
      name: "alice-dev",
      actorUserId: "owner-1",
      limit: 5,
    });

    expect(h.access.authorize).toHaveBeenCalledWith({
      name: "alice-dev",
      actorUserId: "owner-1",
    });
    expect(result?.preview).toEqual({
      name: "alice-dev",
      url: "https://alice-dev.example.test",
    });
    expect(h.proxy.listExecutions).toHaveBeenCalledWith({
      target: {
        name: "alice-dev",
        url: "https://alice-dev.example.test",
        pool: "pool-1",
        identity: {
          previewName: "alice-dev",
          environmentRequestId: "request-1",
          environmentPlatformRevision: "a".repeat(40),
          environmentSourceRevision: "b".repeat(40),
          catalogDigest: `sha256:${"d".repeat(64)}`,
        },
      },
      limit: 5,
      status: null,
    });
  });

  it("returns a degraded adapter result untouched", async () => {
    const h = harness();
    h.proxy.listExecutions = vi.fn(async () => ({
      ok: false as const,
      reason: "unreachable" as const,
      message: "timeout",
    }));

    const result = await h.service.listPreviewExecutions({
      name: "alice-dev",
      actorUserId: "admin-1",
    });

    expect(result?.result).toEqual({
      ok: false,
      reason: "unreachable",
      message: "timeout",
    });
  });

  it("proxies execution detail with the authorized generation", async () => {
    const h = harness();

    const result = await h.service.getPreviewExecution({
      name: "alice-dev",
      actorUserId: "owner-1",
      executionId: "e1",
    });

    expect(result?.result).toEqual({ ok: true, data: { id: "e1" } });
    expect(h.proxy.getExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "e1",
        target: expect.objectContaining({
          identity: expect.objectContaining({ environmentRequestId: "request-1" }),
        }),
      }),
    );
  });

  it("rejects incomplete identities before the outbound adapter", async () => {
    const h = harness(preview({ provenance: null }));

    await expect(
      h.service.listPreviewExecutions({
        name: "alice-dev",
        actorUserId: "owner-1",
      }),
    ).rejects.toThrow("complete immutable identity");
    expect(h.proxy.listExecutions).not.toHaveBeenCalled();
  });

  it("rejects preview-deployment use before authorization or transport", async () => {
    const h = harness();
    h.scope.isControlPlane.mockReturnValueOnce(false);

    await expect(
      h.service.listPreviewExecutions({
        name: "alice-dev",
        actorUserId: "owner-1",
      }),
    ).rejects.toThrow("unavailable from a preview deployment");
    expect(h.access.authorize).not.toHaveBeenCalled();
    expect(h.proxy.listExecutions).not.toHaveBeenCalled();
  });
});
