import { describe, expect, it, vi } from "vitest";
import { TektonPreviewActivationBuildAdapter } from "$lib/server/application/adapters/preview-activation-build";
import { DEV_PREVIEW_CATALOG_DIGEST } from "$lib/server/workflows/dev-preview-registry";

const SOURCE_SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

function input() {
  return {
    requestId: "gate-pr-42",
    artifact: "dev-sync-sidecar" as const,
    sourceRepository: "PittampalliOrg/workflow-builder" as const,
    sourceRevision: SOURCE_SHA as never,
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
  };
}

describe("TektonPreviewActivationBuildAdapter", () => {
  it("returns owner-bound exact-head digest proof", async () => {
    let manifest: Record<string, any> | undefined;
    const client = {
      create: vi.fn(async (_namespace, body, options) => {
        manifest = body;
        return {
          created: true,
          pipelineRun: {
            ...body,
            metadata: { ...body.metadata, uid: "activation-run-uid" },
          },
        };
      }),
      get: vi.fn(async (_namespace, name, _options) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: "activation-run-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value: `ghcr.io/pittampalliorg/dev-sync-sidecar:git-${SOURCE_SHA}`,
            },
            { name: "image_digest", value: DIGEST },
          ],
        },
      })),
      listTasks: vi.fn(async () => []),
    };
    const adapter = new TektonPreviewActivationBuildAdapter({
      client: client as never,
      sleep: vi.fn(async () => undefined),
    });

    await expect(adapter.build(input())).resolves.toEqual({
      artifact: "dev-sync-sidecar",
      sourceRevision: SOURCE_SHA,
      pipelineRun: expect.stringMatching(
        /^activation-dev-sync-sidecar-aaaaaaaaaa-[0-9a-f]{8}$/,
      ),
      imageRef: `ghcr.io/pittampalliorg/dev-sync-sidecar:git-${SOURCE_SHA}`,
      digest: DIGEST,
      immutableRef: `ghcr.io/pittampalliorg/dev-sync-sidecar@${DIGEST}`,
    });
    expect(manifest?.spec).toMatchObject({
      pipelineRef: { name: "build-dev-sync-sidecar-activation" },
      params: [{ name: "source_revision", value: SOURCE_SHA }],
      timeouts: { pipeline: "1h0m0s" },
      taskRunTemplate: {
        serviceAccountName: "activation-image-build-executor",
        podTemplate: { hostUsers: false },
      },
    });
    expect(client.create.mock.calls[0]?.[2]).toEqual({
      targetCluster: "hub-preview-activation",
    });
    expect(client.get.mock.calls[0]?.[2]).toEqual({
      targetCluster: "hub-preview-activation",
    });
  });

  it("fails closed on source, catalog, ownership, ref, and digest drift", async () => {
    const noCall = vi.fn(async () => {
      throw new Error("must not submit");
    });
    const strict = new TektonPreviewActivationBuildAdapter({
      client: { create: noCall, get: noCall, listTasks: noCall } as never,
    });
    await expect(
      strict.build({ ...input(), sourceRepository: "attacker/repo" as never }),
    ).rejects.toThrow(/restricted/);
    await expect(
      strict.build({ ...input(), sourceRevision: "main" as never }),
    ).rejects.toThrow(/full Git SHA/);
    await expect(
      strict.build({
        ...input(),
        catalogDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).rejects.toThrow(/catalog digest/);

    const response = (overrides: Record<string, unknown> = {}) => ({
      create: vi.fn(async (_namespace, body) => ({
        created: true,
        pipelineRun: {
          ...body,
          metadata: { ...body.metadata, uid: "created-uid" },
        },
      })),
      get: vi.fn(async (_namespace, name) => ({
        metadata: {
          name,
          namespace: "tekton-pipelines",
          uid: overrides.uid ?? "created-uid",
        },
        status: {
          conditions: [{ type: "Succeeded", status: "True" }],
          results: [
            {
              name: "image_ref",
              value:
                overrides.imageRef ??
                `ghcr.io/pittampalliorg/dev-sync-sidecar:git-${SOURCE_SHA}`,
            },
            {
              name: "image_digest",
              value: overrides.digest ?? DIGEST,
            },
          ],
        },
      })),
      listTasks: vi.fn(async () => []),
    });
    await expect(
      new TektonPreviewActivationBuildAdapter({
        client: response({ uid: "replaced-uid" }) as never,
      }).build(input()),
    ).rejects.toThrow(/changed Kubernetes ownership/);
    await expect(
      new TektonPreviewActivationBuildAdapter({
        client: response({
          imageRef: `ghcr.io/pittampalliorg/other:git-${SOURCE_SHA}`,
        }) as never,
      }).build(input()),
    ).rejects.toThrow(/unexpected image_ref/);
    await expect(
      new TektonPreviewActivationBuildAdapter({
        client: response({ digest: "unknown" }) as never,
      }).build(input()),
    ).rejects.toThrow(/immutable digest/);
  });
});
