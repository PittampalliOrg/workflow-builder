import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewEnvironmentObservationBrokerService } from "$lib/server/application/preview-environment-observation-broker";
import {
  PreviewRuntimeIdentityChangedError,
  type AuthorizedPreviewControlSource,
  type ImmutableGitSha,
  type PreviewControlIdentity,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

const identity = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  environmentPlatformRevision: "a".repeat(40),
  environmentSourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"d".repeat(64)}` as const,
};

const preview: VclusterPreviewRecord = {
  name: identity.previewName,
  phase: "ready",
  ready: true,
  url: "https://feature-one.example.test",
  targetCluster: "dev",
  pool: null,
  state: "hot",
  lifecycle: "ephemeral",
  origin: { kind: "interactive-session", reference: "session-1" },
  legacyOrigin: "user",
  prNumber: null,
  expiresAt: "2026-07-14T12:00:00.000Z",
  lastActive: "2026-07-13T12:00:00.000Z",
  protected: false,
  bootSeconds: null,
  platformRevision: identity.environmentPlatformRevision as ImmutableGitSha,
  sourceRevision: identity.environmentSourceRevision as ImmutableGitSha,
  profile: "app-live",
  lane: "application",
  mode: "live",
  owner: { kind: "user", id: "user-1" },
  services: ["workflow-builder"],
  provenance: {
    requestId: identity.environmentRequestId,
    requestedAt: "2026-07-13T12:00:00.000Z",
    platformRepository: "PittampalliOrg/stacks",
    sourceRepository: "PittampalliOrg/workflow-builder",
  },
  trustedCode: true,
  allocation: { kind: "cold" },
  images: { "workflow-builder": "ghcr.io/example/workflow-builder:test" },
  catalogDigest: identity.catalogDigest,
};

const authorizedSource: AuthorizedPreviewControlSource = {
  previewName: identity.previewName,
  requestId: identity.environmentRequestId,
  owner: "user-1",
  platformRevision: identity.environmentPlatformRevision as ImmutableGitSha,
  sourceRevision: identity.environmentSourceRevision as ImmutableGitSha,
  catalogDigest: identity.catalogDigest,
  services: ["workflow-builder"],
};

function harness() {
  const authorizeRuntimeTuple = vi.fn(
    async (_input: PreviewControlIdentity): Promise<AuthorizedPreviewControlSource> =>
      authorizedSource,
  );
  const get = vi.fn(async () => preview);
  const runtimeForIdentity = vi.fn(async (_input: typeof identity) => ({
    name: identity.previewName,
    resourceName: "feature-one",
    reconciliationSucceeded: true,
    upJob: {
      name: "vcluster-feature-one-up",
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
            pod: "workflow-builder-0",
            image: "ghcr.io/example/workflow-builder:test",
            imageId: "sha256:image",
            ready: true,
          },
        ],
      },
    ],
    identity,
  }));
  return {
    authorizeRuntimeTuple,
    get,
    runtimeForIdentity,
    service: new ApplicationPreviewEnvironmentObservationBrokerService({
      authority: { authorizeRuntimeTuple },
      previews: { get, runtimeForIdentity },
    }),
  };
}

describe("ApplicationPreviewEnvironmentObservationBrokerService", () => {
  it("fences a record read with physical tuple authority before and after", async () => {
    const h = harness();

    await expect(h.service.inspect(identity)).resolves.toEqual(preview);

    expect(h.authorizeRuntimeTuple).toHaveBeenCalledTimes(2);
    expect(h.get).toHaveBeenCalledWith(identity.previewName);
    expect(h.authorizeRuntimeTuple.mock.invocationCallOrder[0]).toBeLessThan(
      h.get.mock.invocationCallOrder[0],
    );
    expect(h.get.mock.invocationCallOrder[0]).toBeLessThan(
      h.authorizeRuntimeTuple.mock.invocationCallOrder[1],
    );
  });

  it("rejects a record from another immutable generation", async () => {
    const h = harness();
    h.get.mockResolvedValueOnce({ ...preview, sourceRevision: "c".repeat(40) });

    await expect(h.service.inspect(identity)).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
    expect(h.authorizeRuntimeTuple).toHaveBeenCalledOnce();
  });

  it("fences a tuple-bound runtime read before and after", async () => {
    const h = harness();

    await expect(h.service.observeRuntime(identity)).resolves.toMatchObject({
      name: identity.previewName,
      identity,
    });

    expect(h.authorizeRuntimeTuple).toHaveBeenCalledTimes(2);
    expect(h.runtimeForIdentity).toHaveBeenCalledWith(identity);
    expect(h.authorizeRuntimeTuple.mock.invocationCallOrder[0]).toBeLessThan(
      h.runtimeForIdentity.mock.invocationCallOrder[0],
    );
    expect(h.runtimeForIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      h.authorizeRuntimeTuple.mock.invocationCallOrder[1],
    );
  });

  it("rejects a mismatched runtime receipt", async () => {
    const h = harness();
    h.runtimeForIdentity.mockResolvedValueOnce({
      ...(await h.runtimeForIdentity(identity)),
      identity: { ...identity, environmentRequestId: "request-2" },
    });
    h.runtimeForIdentity.mockClear();

    await expect(h.service.observeRuntime(identity)).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
    expect(h.authorizeRuntimeTuple).toHaveBeenCalledOnce();
  });

  it("fails closed when the post-read authority check observes replacement", async () => {
    const h = harness();
    h.authorizeRuntimeTuple.mockResolvedValueOnce(authorizedSource);
    h.authorizeRuntimeTuple.mockRejectedValueOnce(new Error("generation replaced"));

    await expect(h.service.inspect(identity)).rejects.toThrow("generation replaced");
  });
});
