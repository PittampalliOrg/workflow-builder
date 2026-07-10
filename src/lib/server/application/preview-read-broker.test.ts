import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewReadBrokerService } from "$lib/server/application/preview-read-broker";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

const digest = `sha256:${"c".repeat(64)}` as const;
const identity = Object.freeze({
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: digest,
});

function record(
  overrides: Partial<VclusterPreviewRecord> = {},
): VclusterPreviewRecord {
  return {
    name: "feature-one",
    phase: "ready",
    ready: true,
    url: "https://feature-one.example.test",
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
    owner: { kind: "user", id: "admin-1" },
    services: ["workflow-builder"],
    provenance: { requestId: "request-1" },
    trustedCode: true,
    allocation: { kind: "cold" },
    images: {},
    catalogDigest: digest,
    ...overrides,
  };
}

function harness(overrides: Partial<VclusterPreviewRecord> = {}) {
  const previews = { get: vi.fn(async () => record(overrides)) };
  const authority = {
    authorizeRuntimeTuple: vi.fn(async () => ({
      previewName: "feature-one",
      requestId: "request-1",
      owner: "admin-1",
      platformRevision: "a".repeat(40) as never,
      sourceRevision: "b".repeat(40) as never,
      catalogDigest: digest,
      services: ["workflow-builder"],
    })),
  };
  const capabilities = { mintControl: vi.fn(() => "d".repeat(64)) };
  const transport = {
    execute: vi.fn(async ({ command }) => ({
      kind: command.kind,
      result: { ok: true, data: { executions: [], total: 0 } },
    })),
  };
  const service = new ApplicationPreviewReadBrokerService({
    previews,
    authority,
    capabilities,
    transport: transport as never,
  });
  return { service, authority, capabilities, transport };
}

describe("central preview read broker", () => {
  it("re-authorizes current physical state and mints only a tuple leaf", async () => {
    const h = harness();
    await h.service.execute({
      previewName: "feature-one",
      identity,
      command: { kind: "list-executions", limit: 25, status: null },
    });
    expect(h.authority.authorizeRuntimeTuple).toHaveBeenCalledWith(identity);
    expect(h.capabilities.mintControl).toHaveBeenCalledWith(
      expect.objectContaining({ previewName: "feature-one" }),
    );
    expect(h.transport.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: {
          name: "feature-one",
          url: "https://feature-one.example.test",
          pool: null,
        },
        capability: "d".repeat(64),
      }),
    );
  });

  it("rejects warm, non-app-live, and incomplete tuple targets", async () => {
    for (const drift of [
      { pool: "pool-1" },
      { profile: "manifest-candidate" as const },
      { platformRevision: null },
    ]) {
      const h = harness(drift);
      await expect(
        h.service.execute({
          previewName: "feature-one",
          identity,
          command: { kind: "list-executions", limit: 25, status: null },
        }),
      ).rejects.toMatchObject({ code: "contract-mismatch" });
      expect(h.transport.execute).not.toHaveBeenCalled();
    }
  });

  it("rejects unbounded file requests before cluster inspection", async () => {
    const h = harness();
    await expect(
      h.service.execute({
        previewName: "feature-one",
        identity,
        command: {
          kind: "fetch-file",
          fileId: "file-1",
          maxBytes: 25 * 1024 * 1024 + 1,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
  });

  it("rejects a stale generation before minting or transport", async () => {
    const h = harness();
    await expect(
      h.service.execute({
        previewName: "feature-one",
        identity: { ...identity, environmentRequestId: "request-2" },
        command: { kind: "list-executions", limit: 25, status: null },
      }),
    ).rejects.toMatchObject({ code: "contract-mismatch" });
    expect(h.authority.authorizeRuntimeTuple).not.toHaveBeenCalled();
    expect(h.capabilities.mintControl).not.toHaveBeenCalled();
    expect(h.transport.execute).not.toHaveBeenCalled();
  });
});
