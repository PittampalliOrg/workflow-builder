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
  const authorizeObservedRuntimeTuple = vi.fn(
    async (
      _input: PreviewControlIdentity,
    ): Promise<AuthorizedPreviewControlSource> => authorizedSource,
  );
  const inspect = vi.fn(async (_input: typeof identity) => ({
    preview,
    identity,
  }));
  const observeRuntime = vi.fn(async (_input: typeof identity) => ({
    preview,
    identity,
    runtime: {
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
    },
  }));
  return {
    authorizeObservedRuntimeTuple,
    inspect,
    observeRuntime,
    service: new ApplicationPreviewEnvironmentObservationBrokerService({
      authority: { authorizeObservedRuntimeTuple },
      observations: { inspect, observeRuntime },
    }),
  };
}

describe("ApplicationPreviewEnvironmentObservationBrokerService", () => {
  it("performs one tuple-fenced record operation and pure source policy", async () => {
    const h = harness();

    await expect(h.service.inspect(identity)).resolves.toEqual(preview);

    expect(h.inspect).toHaveBeenCalledOnce();
    expect(h.inspect).toHaveBeenCalledWith(identity);
    expect(h.authorizeObservedRuntimeTuple).toHaveBeenCalledOnce();
    expect(h.inspect.mock.invocationCallOrder[0]).toBeLessThan(
      h.authorizeObservedRuntimeTuple.mock.invocationCallOrder[0],
    );
  });

  it("rejects a record from another immutable generation", async () => {
    const h = harness();
    h.inspect.mockResolvedValueOnce({
      preview: { ...preview, sourceRevision: "c".repeat(40) },
      identity,
    });

    await expect(h.service.inspect(identity)).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
    expect(h.inspect).toHaveBeenCalledOnce();
    expect(h.authorizeObservedRuntimeTuple).not.toHaveBeenCalled();
  });

  it("performs one tuple-fenced runtime operation with its authoritative record", async () => {
    const h = harness();

    await expect(h.service.observeRuntime(identity)).resolves.toMatchObject({
      preview,
      identity,
      runtime: { name: identity.previewName, identity },
    });

    expect(h.observeRuntime).toHaveBeenCalledOnce();
    expect(h.observeRuntime).toHaveBeenCalledWith(identity);
    expect(h.authorizeObservedRuntimeTuple).toHaveBeenCalledOnce();
    expect(h.observeRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      h.authorizeObservedRuntimeTuple.mock.invocationCallOrder[0],
    );
  });

  it("rejects a mismatched runtime receipt", async () => {
    const h = harness();
    const baseline = await h.observeRuntime(identity);
    h.observeRuntime.mockResolvedValueOnce({
      ...baseline,
      runtime: {
        ...baseline.runtime,
        identity: { ...identity, environmentRequestId: "request-2" },
      },
    });
    h.observeRuntime.mockClear();

    await expect(h.service.observeRuntime(identity)).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
    expect(h.observeRuntime).toHaveBeenCalledOnce();
    expect(h.authorizeObservedRuntimeTuple).not.toHaveBeenCalled();
  });

  it("rejects a runtime receipt whose embedded record was replaced", async () => {
    const h = harness();
    const baseline = await h.observeRuntime(identity);
    h.observeRuntime.mockResolvedValueOnce({
      ...baseline,
      preview: { ...preview, provenance: { ...preview.provenance!, requestId: "request-2" } },
    });
    h.observeRuntime.mockClear();

    await expect(h.service.observeRuntime(identity)).rejects.toBeInstanceOf(
      PreviewRuntimeIdentityChangedError,
    );
    expect(h.observeRuntime).toHaveBeenCalledOnce();
    expect(h.authorizeObservedRuntimeTuple).not.toHaveBeenCalled();
  });
});
